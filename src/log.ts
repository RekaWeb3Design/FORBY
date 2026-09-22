// Errors and alarm traces: the browser console plus a line in the terminal running `tauri dev`
import {invoke} from "@tauri-apps/api/core";

const describe = (err: unknown) => (err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err));

const toTerminal = (level: "error" | "info", message: string) => {
  invoke("log", {level, message}).catch(() => {});
};

export const logError = (message: string, err?: unknown) => {
  console.error(`FORBY: ${message}`, err);
  toTerminal("error", err === undefined ? message : `${message}: ${describe(err)}`);
};

export const logInfo = (message: string) => {
  console.info(`FORBY: ${message}`);
  toTerminal("info", message);
};
