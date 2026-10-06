import { createRoot } from "react-dom/client";
import App from "./App";
import { webSocketTransport } from "./transport";
import "./styles.css";

// The dev-harness panel: the session runs on the local server.
const transport = webSocketTransport();
createRoot(document.getElementById("root")!).render(<App transport={transport} />);
