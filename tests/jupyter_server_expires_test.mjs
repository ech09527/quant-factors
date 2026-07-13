import { resolveExpiresAt } from "../workers/factor-ideas/src/jupyter-server-db.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const now = Date.now();

assert(resolveExpiresAt({}) === null, "permanent server should have no expiry");

const tempDefault = resolveExpiresAt({ temporary: true });
assert(tempDefault, "temporary default should set expiry");
assert(Date.parse(tempDefault) > now + 23 * 60 * 60 * 1000, "temporary default should be ~24h");

const tempHours = resolveExpiresAt({ temporary: true, expires_in_hours: 6 });
assert(
  Date.parse(tempHours) > now + 5.5 * 60 * 60 * 1000 &&
    Date.parse(tempHours) < now + 6.5 * 60 * 60 * 1000,
  "expires_in_hours should control expiry",
);

const explicit = resolveExpiresAt({ expires_at: "2030-01-01T00:00:00.000Z" });
assert(explicit === "2030-01-01T00:00:00.000Z", "explicit expires_at should pass through");

let threw = false;
try {
  resolveExpiresAt({ expires_in_hours: 0 });
} catch (error) {
  threw = true;
  assert(String(error.message).includes("过期时间"), "invalid expiry should throw");
}
assert(threw, "zero expiry should throw");

console.log("jupyter_server_expires_test.mjs passed");
