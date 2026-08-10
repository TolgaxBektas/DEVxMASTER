import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import "@xmaster-center/ui/styles.css";
import "./web.css";
import { App } from "./App.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <Toaster theme="dark" position="bottom-right" />
  </StrictMode>,
);
