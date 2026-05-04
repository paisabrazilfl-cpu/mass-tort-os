import { encrypt } from "./src/lib/encryption";
import pg from "pg";

async function main() {
  const { Client } = pg;
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const creds = {
    access_id: "432213",
    access_password: "1Giselle!",
    fax_number: "+16144552138",
  };

  const ins = await client.query(
    `INSERT INTO integrations (name, type, provider, status, config) VALUES ($1,$2,$3,'active',$4) RETURNING id`,
    ["SRFax", "fax", "srfax", JSON.stringify({ credentials: {} })],
  );
  const id = ins.rows[0].id;

  const encCreds: Record<string, string> = {};
  for (const [k, v] of Object.entries(creds)) {
    encCreds[k] = encrypt(String(v), `integration:${k}`, String(id));
  }

  await client.query(
    `UPDATE integrations SET config = $1 WHERE id = $2`,
    [JSON.stringify({ credentials: encCreds }), id],
  );

  console.log(`SRFax integration saved with id=${id}`);
  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
