import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
// Side-effect import: registers the bearer-token getter on the shared
// customFetch instance before any React Query hook fires.
import "./lib/api-fetch";

createRoot(document.getElementById("root")!).render(<App />);
