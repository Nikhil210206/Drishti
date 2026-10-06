// Pathik Rail on its own (no agent, no browser): the practice site for trying the extension.
import { config } from "../src/config.js";
import { startMockSite } from "../src/mock-server.js";

await startMockSite();
console.log(`Pathik Rail practice site → http://localhost:${config.mockPort}/`);
