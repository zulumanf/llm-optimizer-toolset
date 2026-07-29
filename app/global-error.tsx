"use client";

/**
 * Last-resort boundary: catches failures in the root layout itself (where
 * the normal error boundary cannot render because the layout is broken).
 * Must ship its own <html>/<body>.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          padding: "3rem",
          maxWidth: "40rem",
          margin: "0 auto",
        }}
      >
        <h1 style={{ fontSize: "1.25rem", fontWeight: 600 }}>
          The application failed to start.
        </h1>
        <p style={{ marginTop: "0.75rem", color: "#666" }}>{error.message}</p>
        {error.digest && (
          <p style={{ marginTop: "0.25rem", fontFamily: "monospace", fontSize: "0.8rem", color: "#888" }}>
            error id {error.digest}
          </p>
        )}
        <p style={{ marginTop: "1rem", color: "#666", fontSize: "0.9rem" }}>
          This usually means the database is unreachable. Check that Postgres
          is running on port 5433, then retry.
        </p>
        <button
          onClick={reset}
          style={{
            marginTop: "1.5rem",
            padding: "0.5rem 1rem",
            border: "1px solid #ccc",
            borderRadius: "0.375rem",
            cursor: "pointer",
          }}
        >
          Retry
        </button>
      </body>
    </html>
  );
}
