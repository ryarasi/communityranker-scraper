import postgres from "postgres";
import { env } from "../lib/env.js";

export const sql = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});
