/**
 * The process-wide activation scanner.
 *
 * It lives in its own module rather than in `index.mjs` because two places need it:
 * `index.mjs` starts it, and the relay route nudges it when a withdrawal is accepted.
 * Constructing it in `index.mjs` would make the route import the entrypoint.
 */
import { activationDestinations } from "./destinations.mjs";
import { AutomaticNoteActivator } from "./note-activator.mjs";
import { postToRelayer } from "./relayer-proxy.mjs";

export const automaticNoteActivator = new AutomaticNoteActivator({
  getDestinations: activationDestinations,
  scan: (destination) => destination.scan(),
  // The app server nominates; the relayer verifies against fresh state and signs.
  activate: (destination, note) =>
    postToRelayer(`/relayer/destinations/${encodeURIComponent(destination.key)}/activate`, {
      commitment: note.commitment.toString(),
    }),
});
