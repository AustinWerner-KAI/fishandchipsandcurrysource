// A Mac notification (top right of the screen), so a reply or a stop is seen without the page open.
// The text goes in as arguments, never inside the script, so a name with quotes cannot break it.
import { spawn } from 'node:child_process';

export function notify(title, body = '') {
  if (process.platform !== 'darwin' || process.env.SOURCER_NO_NOTIFY) return false;
  try {
    const p = spawn('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"', '-e', 'end run',
      String(title).slice(0, 100), String(body).replace(/\s+/g, ' ').slice(0, 200)], { stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
    return true;
  } catch { return false; }
}
