export async function sendToMainDevice(command, payload = {}) {
  return {
    ok: true,
    device: "local-browser",
    command,
    payload
  };
}
