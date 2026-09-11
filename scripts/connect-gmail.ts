/**
 * One-time Gmail authorization (spec 091). Mints the platform's Gmail
 * connection: runs the Google OAuth consent flow on a loopback listener,
 * stores the tokens through the credential boundary (the only module that
 * encrypts), and verifies the mailbox before declaring success. Re-running
 * for the same account rotates the credential on the existing connection.
 *
 * Prerequisites (operator, once, in Google Cloud console):
 *   - a project with the Gmail API enabled
 *   - an OAuth client (type: Web application) with redirect URI
 *     http://localhost:8791/callback
 *   - the consent screen PUBLISHED (Testing-mode refresh tokens expire after
 *     7 days of inactivity — scheduled sends need a durable one)
 *
 * Run with:
 *   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... \
 *     npx tsx scripts/connect-gmail.ts --send-as francisco@recommendedfirst.com
 *
 * Optional flags:
 *   --project <uuid>          scope the connection to one client project
 *                             (default: platform-level, used by prospect outreach)
 *   --operator-email <email>  the users row recorded as creator
 *                             (default: zulumanf@gmail.com)
 *
 * Client id/secret come from env, never argv — argv leaks into shell history.
 * They are stored in the connection config because the adapter's shared
 * googleRefresh reads them from there by design; the tokens themselves go
 * through lib/connectors/credentials.ts (encrypted at rest, needs
 * AUTOMATION_CREDENTIAL_KEY in .env).
 */
import "dotenv/config";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { sql } from "@/db/client";
import { insertConnection, setConnectionStatus } from "@/db/connectors";
import { storeCredential } from "@/lib/connectors/credentials";
import { checkConnection } from "@/lib/connectors/health";

const CALLBACK_PORT = 8791;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
];

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) return null;
  return process.argv[index + 1] ?? null;
}

/** Serve exactly one OAuth callback, then close the listener. */
function waitForCode(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (err || !code || state !== expectedState) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end(`Authorization failed: ${err ?? "missing code or state mismatch"}. You can close this tab.`);
        server.close();
        reject(new Error(`OAuth callback error: ${err ?? "missing code or state mismatch"}`));
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Gmail authorized — you can close this tab and return to the terminal.");
      server.close();
      resolve(code);
    });
    server.on("error", reject);
    server.listen(CALLBACK_PORT);
  });
}

async function main(): Promise<void> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID ?? "";
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "";
  const sendAsAddress = argValue("--send-as");
  const projectId = argValue("--project");
  const operatorEmail = argValue("--operator-email") ?? "zulumanf@gmail.com";

  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set in the environment."
    );
  }
  if (!sendAsAddress || !sendAsAddress.includes("@")) {
    throw new Error("--send-as <address> is required: the address outbound mail comes from.");
  }

  const [operator] = await sql`
    select id from users where email = ${operatorEmail} and active
  `;
  if (!operator) throw new Error(`No active user with email ${operatorEmail}.`);
  const operatorId = operator.id as string;

  // ---- Consent -------------------------------------------------------------
  const state = randomBytes(16).toString("hex");
  const consentUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: SCOPES.join(" "),
      // offline + consent forces a refresh token even on re-authorization.
      access_type: "offline",
      prompt: "consent",
      state,
      login_hint: sendAsAddress,
    }).toString();

  console.log("\nOpen this URL in a browser and authorize the SENDING mailbox:\n");
  console.log(consentUrl);
  console.log(`\nWaiting for the callback on ${REDIRECT_URI} …`);
  const code = await waitForCode(state);

  // ---- Token exchange ------------------------------------------------------
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  const tokens = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!tokenResponse.ok || !tokens.access_token) {
    throw new Error(`Token exchange failed (${tokenResponse.status}): ${JSON.stringify(tokens)}`);
  }
  if (!tokens.refresh_token) {
    throw new Error(
      "Google returned no refresh token. Revoke the app's access at myaccount.google.com/permissions and re-run — scheduled sends cannot survive on an access token alone."
    );
  }

  // ---- Whose mailbox did we actually get? ----------------------------------
  const profileResponse = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    { headers: { authorization: `Bearer ${tokens.access_token}` } }
  );
  const profile = (await profileResponse.json()) as { emailAddress?: string };
  if (!profileResponse.ok || !profile.emailAddress) {
    throw new Error(`Could not read the authorized mailbox's profile (${profileResponse.status}).`);
  }
  const accountEmail = profile.emailAddress.toLowerCase();
  if (accountEmail !== sendAsAddress.toLowerCase()) {
    console.warn(
      `\nNOTE: you authorized ${accountEmail} but --send-as is ${sendAsAddress}. ` +
        "That only works if the mailbox has this send-as alias verified in Gmail settings."
    );
  }

  const grantedScopes = (tokens.scope ?? SCOPES.join(" ")).split(" ").filter(Boolean);
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000)
    : null;
  const config = { userId: "me", sendAsAddress, clientId, clientSecret };

  // ---- Upsert the connection, rotate the credential ------------------------
  const connectionId = await sql.begin(async (tx) => {
    const [existing] = await tx`
      select id from connector_connections
      where provider = 'gmail'
        and project_id is not distinct from ${projectId}
        and external_account_id = ${accountEmail}
    `;
    if (existing) {
      await tx`
        update connector_connections set
          config = ${tx.json(config as never)},
          granted_scopes = ${grantedScopes},
          expires_at = ${expiresAt},
          status = 'pending',
          revoked_at = null,
          last_error = null
        where id = ${existing.id}
      `;
      return existing.id as string;
    }
    return insertConnection(tx, {
      projectId,
      provider: "gmail",
      connectionName: `Gmail (${accountEmail})`,
      externalAccountId: accountEmail,
      grantedScopes,
      config,
      expiresAt,
      createdBy: operatorId,
    });
  });

  await storeCredential({
    connectionId,
    kind: "oauth2",
    secret: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt,
    userId: operatorId,
  });

  // ---- Verify before declaring success -------------------------------------
  const outcome = await checkConnection(connectionId);
  console.log(
    `\nHealth check: authorization ${outcome.authorizationOk ? "ok" : "FAILED"}, ` +
      `read ${outcome.readOk ? "ok" : "FAILED"} (${outcome.latencyMs}ms)` +
      (outcome.errorMessage ? ` — ${outcome.errorMessage}` : "")
  );
  if (!outcome.authorizationOk || !outcome.readOk) {
    process.exitCode = 1;
    console.error("The connection is stored but NOT healthy — fix the error above and re-run.");
    return;
  }
  await sql.begin((tx) =>
    setConnectionStatus(tx, { connectionId, status: "active" })
  );
  console.log(
    `\nGmail connected: ${accountEmail} (connection ${connectionId}, ` +
      `${projectId ? `project ${projectId}` : "platform-level"}). ` +
      "Prospect sends and scheduled sends can now transmit."
  );
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void sql.end());
