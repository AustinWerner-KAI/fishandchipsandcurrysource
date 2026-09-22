// A polite stop: set when the runner is asked to stop (Stop button, or an update restart).
// Loops check it between people, so an invite or message is never cut off halfway.
export const stopFlag = { on: false };
export const stopRequested = () => stopFlag.on;
