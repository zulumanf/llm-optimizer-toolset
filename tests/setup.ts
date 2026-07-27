import * as dotenv from "dotenv";

dotenv.config();

// Integration tests must never touch the dev database
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
