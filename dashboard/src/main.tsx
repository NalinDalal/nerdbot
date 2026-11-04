import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { installLinkInterceptor } from "./router";
import "./styles.css";

/* One global left-click interceptor for the whole app: same-origin anchors
 * navigate with pushState instead of re-mounting the dashboard. */
installLinkInterceptor();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
