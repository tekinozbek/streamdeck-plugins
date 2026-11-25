import streamDeck from "@elgato/streamdeck";
import { Clock } from "./actions/clock";

streamDeck.actions.registerAction(new Clock());
streamDeck.connect();
