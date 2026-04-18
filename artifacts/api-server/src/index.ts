import app from "./app";
import { logger } from "./lib/logger";
import { seedFormConfigurations } from "./lib/form-config-service";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Seed/refresh form configurations from TORT_REGISTRY on boot.
  // Safe: inserts missing rows and refreshes only rows where updated_by IS NULL
  // (admin-edited rows are never overwritten).
  try {
    await seedFormConfigurations();
  } catch (e) {
    logger.error({ err: e }, "Form configuration seed failed on boot");
  }
});
