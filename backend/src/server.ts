import { createApp } from "./app.js";
import { loadAppConfig } from "./domain/config.js";

const config = loadAppConfig();
const app = await createApp(config);

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Server listening on http://${config.host}:${config.port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
