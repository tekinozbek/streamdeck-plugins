import streamDeck from "@elgato/streamdeck";
import path from "node:path";
import { ApiToggle } from "./actions/api-toggle";
import { CallWebhook } from "./actions/call-webhook";
import { startLogCap } from "./log-cap";

// Same folder and file prefix the SDK's file logger uses (cwd is the .sdPlugin folder).
const pluginDir = process.cwd();
const dirName = path.basename(pluginDir);
const prefix = dirName.endsWith(".sdPlugin") ? dirName.slice(0, -".sdPlugin".length) : dirName;
startLogCap(path.join(pluginDir, "logs"), prefix);

streamDeck.actions.registerAction(new CallWebhook());
streamDeck.actions.registerAction(new ApiToggle());
streamDeck.connect();

