/**
 * Decrypts the SendGrid API key from the integrations vault,
 * queries SendGrid for verified senders, then writes the first
 * verified sender back as `from_email` in the integration credentials
 * and updates workflow_settings.default_email_from_address.
 */
import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getKey(version = 1): Buffer {
  const raw = process.env[`ENCRYPTION_KEY_V${version}`] ?? process.env["ENCRYPTION_KEY"];
  if (!raw) throw new Error(`ENCRYPTION_KEY_V${version} not set`);
  return Buffer.from(raw, "hex");
}

function buildAAD(field: string, entityId?: string): Buffer {
  return Buffer.from(entityId ? `${field}:${entityId}` : field, "utf8");
}

function tryDecrypt(payload: string, keyVer: number, aad: Buffer | undefined): string | null {
  try {
    const key = getKey(keyVer);
    const combined = Buffer.from(payload, "base64");
    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const enc = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const d = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    d.setAuthTag(authTag);
    if (aad) d.setAAD(aad);
    return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
  } catch { return null; }
}

function decryptField(ciphertext: string, field: string, entityId: string): string {
  const parts = ciphertext.split(":");
  const keyVer = parseInt(parts[1].slice(1), 10) || 1;
  const hasAAD = parseInt(parts[2], 10) || 0;
  const payload = parts.slice(3).join(":");

  const candidates: (Buffer | undefined)[] = [];
  if (hasAAD) {
    candidates.push(buildAAD(field, entityId));
    candidates.push(buildAAD(field));
  }
  candidates.push(undefined);

  for (const aad of candidates) {
    const r = tryDecrypt(payload, keyVer, aad);
    if (r !== null) return r;
  }
  throw new Error(`Failed to decrypt ${field} for entity ${entityId}`);
}

function encryptField(plaintext: string, field: string, entityId: string): string {
  const key = getKey(1);
  const iv = crypto.randomBytes(IV_LENGTH);
  const aad = buildAAD(field, entityId);
  const c = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  c.setAAD(aad);
  const enc = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  const combined = Buffer.concat([iv, c.getAuthTag(), enc]);
  return `enc:v1:1:${combined.toString("base64")}`;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // 1. Read the SendGrid integration row
    const { rows } = await pool.query(
      "SELECT id, config FROM integrations WHERE id = 44"
    );
    if (!rows.length) throw new Error("SendGrid integration (id=44) not found");

    const row = rows[0];
    const storedCreds = row.config?.credentials ?? {};
    const encApiKey = storedCreds.api_key;
    if (!encApiKey) throw new Error("No api_key in integration credentials");

    console.log("Decrypting SendGrid API key...");
    const apiKey = decryptField(encApiKey, "integration:api_key", String(row.id));
    console.log(`API key decrypted (length=${apiKey.length})`);

    // 2. Call SendGrid verified senders API
    console.log("Querying SendGrid verified senders...");
    const resp = await fetch("https://api.sendgrid.com/v3/verified_senders", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`SendGrid API error ${resp.status}: ${body}`);
    }

    const data = await resp.json() as { results?: Array<{ from_email: string; from_name: string; verified: boolean }> };
    const verified = (data.results ?? []).filter((s) => s.verified);
    console.log(`Found ${data.results?.length ?? 0} senders, ${verified.length} verified`);

    if (!verified.length) {
      // Also try domain authentication approach — check authenticated domains
      const domResp = await fetch("https://api.sendgrid.com/v3/whitelabel/domains?limit=5", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const domData = await domResp.json() as Array<{ valid: boolean; domain: string; default: boolean; username: string }>;
      const validDomains = domData.filter((d) => d.valid);
      console.log(`Domain auth: ${domData.length} domains, ${validDomains.length} valid`);

      if (validDomains.length) {
        const dom = validDomains.find((d) => d.default) ?? validDomains[0];
        // Use noreply@ on the authenticated domain
        const fromEmail = `noreply@${dom.domain}`;
        const fromName = "Mass Tort OS";
        console.log(`Using domain-auth sender: ${fromEmail}`);
        await writeFromEmail(pool, row.id, fromEmail, fromName);
      } else {
        console.log("No verified single senders or authenticated domains found.");
        console.log("Checking account email as fallback...");
        const profileResp = await fetch("https://api.sendgrid.com/v3/user/email", {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (profileResp.ok) {
          const profile = await profileResp.json() as { email?: string };
          console.log(`Account email: ${profile.email}`);
          if (profile.email) {
            console.log(`Setting from_email to account email: ${profile.email}`);
            await writeFromEmail(pool, row.id, profile.email, "Mass Tort OS");
          }
        }
        console.log("\nACTION NEEDED: Go to app.sendgrid.com → Settings → Sender Authentication and verify at least one sender.");
        console.log("Or add a domain in Settings → Sender Authentication → Domain Authentication.");
      }
      return;
    }

    const sender = verified[0];
    console.log(`Using verified sender: ${sender.from_email} (${sender.from_name})`);
    await writeFromEmail(pool, row.id, sender.from_email, sender.from_name);

  } finally {
    await pool.end();
  }
}

async function writeFromEmail(pool: pg.Pool, integrationId: number, fromEmail: string, fromName: string) {
  // Encrypt from_email and from_name using same AAD scheme as api_key
  const encFromEmail = encryptField(fromEmail, "integration:from_email", String(integrationId));
  const encFromName = encryptField(fromName, "integration:from_name", String(integrationId));

  // Update integration credentials — merge from_email and from_name into config.credentials
  await pool.query(`
    UPDATE integrations
    SET config = jsonb_set(
      jsonb_set(config, '{credentials,from_email}', $1::jsonb),
      '{credentials,from_name}', $2::jsonb
    ),
    updated_at = now()
    WHERE id = $3
  `, [JSON.stringify(encFromEmail), JSON.stringify(encFromName), integrationId]);

  console.log(`Updated integration ${integrationId} credentials with from_email`);

  // Update workflow_settings default_email_from_address
  await pool.query(`
    UPDATE workflow_settings
    SET default_email_from_address = $1,
        default_email_from_name = $2,
        updated_at = now()
    WHERE scope = 'global'
  `, [fromEmail, fromName]);

  console.log(`Updated workflow_settings.default_email_from_address = ${fromEmail}`);
  console.log("Done. Email delivery is now configured.");
}

main().catch((err) => {
  console.error("Script failed:", err.message);
  process.exit(1);
});
