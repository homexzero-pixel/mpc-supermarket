# Store print agent (counter computer)

The agent is a small Node.js program on the counter PC. It **connects out** to the Scan & Shop server every 2 seconds, collects slips for its printers and sends them to the thermal printer. No ports need to be opened in the shop and the printer never needs to be reachable from the internet.

## Install

1. Install Node.js 22 LTS on the counter PC.
2. Copy this project (or just `dist/`, `package.json`, `node_modules/`) to the PC and run `npm ci && npm run build`.
3. In **Admin → Settings → Store print agents**, create an agent (the token is shown once) and set each printer's **Served by agent**.
4. Copy `agent/agent.config.example.json` to e.g. `C:\MPC\agent.config.json` and fill in `server`, `token` and one entry per printer id (shown under Settings → Printers).

### Printer targets

| Printer connection | `target` |
|---|---|
| Network (LAN/Wi-Fi) thermal printer | `tcp://192.168.1.50:9100` (set a fixed IP on the printer) |
| USB printer on Windows | Share the printer (e.g. `POS80`) with the **Generic / Text Only** driver, then `file:\\\\localhost\\POS80` |
| USB printer on Linux | `file:/dev/usb/lp0` (add the user to the `lp` group) |
| Simulator (demo) | `dir:./data/sim-prints` |

Add `"statusQuery": true` for network printers that answer the ESC/POS paper-status request; the agent then refuses to print when the paper is out and raises an alert instead.

## Run

```bash
AGENT_CONFIG=C:/MPC/agent.config.json npm run agent
```

Start on boot — **Windows:** Task Scheduler → "At log on" → `node.exe --disable-warning=ExperimentalWarning C:\MPC\dist\agent\print-agent.js` with environment variable `AGENT_CONFIG`, or use NSSM to run it as a service. **Linux:** a systemd unit like the server's with `ExecStart=/usr/bin/node dist/agent/print-agent.js` and `Environment=AGENT_CONFIG=/opt/mpc/agent.config.json`.

## What the statuses mean

| Status | Meaning | What staff do |
|---|---|---|
| Print queued / Printing… | waiting for / being handled by the agent | nothing |
| Sent to printer | printer accepted all bytes (most printers can't confirm paper output) | nothing |
| Printed | confirmed (simulator) | nothing |
| **PRINT FAILED** | nothing was printed (printer off, cable, paper out) | fix the printer, press **Retry print** — the original slip is sent again |
| **Print unconfirmed** | the print may or may not have come out (agent crashed, error mid-print) | look at the printer; if no slip, **Reprint COPY** with a reason |

The order is always visible on the cashier screen, whatever happens to the slip. A slip problem never changes order or payment status. Reprints are marked **COPY** and recorded with who, when and why.

If the agent cannot reach the server it keeps retrying and remembers outcomes it could not report yet (`stateFile`), sending them once the connection is back.

## Tamil on slips

Thermal printers' built-in fonts have no Tamil glyphs. Slips print in English; if a printer is set to Tamil, Tamil names are used where the agent supports image (raster) printing and otherwise fall back to English automatically. Raster printing of Tamil text is **not implemented yet** — it needs the actual printer model to test. Customers' phones and the cashier screen show Tamil normally.

## Troubleshooting

- *"agent offline"* on the cashier screen: the agent isn't running or the PC has no internet.
- *ECONNREFUSED / timeout*: printer off, wrong IP, or a different port.
- *Token rejected*: create a new token in Settings and update the config.
- Use **Settings → Print test slip** after any change.
