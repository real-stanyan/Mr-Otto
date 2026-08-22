import React from "react";
import { createRoot } from "react-dom/client";
import { Island } from "./Island.js";
import "../app.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Island />
  </React.StrictMode>
);
