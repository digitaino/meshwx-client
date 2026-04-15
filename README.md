# MeshWX

**Mesh Weather Client** — receive live weather data over LoRa mesh networks using a [MeshCore](https://github.com/rme-mesh/meshcore) companion radio.

MeshWX connects to your radio via USB Serial or Bluetooth Low Energy, joins the mesh weather data channel, and displays a live dashboard with observations, forecasts, radar, warnings, and more.

## What You Need

- A **MeshCore companion radio** (any MeshCore-compatible LoRa device)
- A **MeshWX weather bot** broadcasting on your mesh network
- **Chrome or Edge** browser (for the web client — requires Web Serial or Web Bluetooth API)

## Quick Start

### Option 1: Download the Desktop App

Download pre-built binaries from the [Releases](https://github.com/digitaino/meshwx-client/releases) page:

| Platform | Download |
|----------|----------|
| macOS (Apple Silicon) | `MeshWX-1.0.0-arm64.dmg` |
| Windows (x64) | `MeshWX-Setup-1.0.0.exe` (installer) or `MeshWX-1.0.0-portable.exe` |
| Linux (x64) | `MeshWX-1.0.0-x64.AppImage` |
| Linux (ARM64) | `MeshWX-1.0.0-arm64.AppImage` |

The macOS build is signed and notarized by Apple. On Linux, you may need to `chmod +x` the AppImage before running it.

### Option 2: Run the Web Client

Requires [Node.js](https://nodejs.org/) (no dependencies to install).

```bash
git clone https://github.com/digitaino/meshwx-client.git
cd meshwx
node serve.js
```

Open **http://localhost:8095** in Chrome or Edge, then click **USB Serial** or **Bluetooth** to connect your radio.

## How It Works

1. **Connect** — MeshWX pairs with your MeshCore companion radio over USB or BLE
2. **Discover** — It scans the mesh for weather bots broadcasting on a discovery channel
3. **Subscribe** — Once a bot is found, it joins the weather data channel
4. **Receive & Decode** — Weather messages arrive as compact binary packets (MeshWX Protocol v4) over LoRa and are decoded in real time
5. **Display** — Data is rendered in a tabbed dashboard with auto-updating cards

## Weather Products

MeshWX decodes and displays the following products from NWS data broadcast over the mesh:

| Product | Description |
|---------|-------------|
| Observations (METAR) | Current conditions — temperature, wind, sky, pressure, visibility |
| Forecasts (PFM) | Multi-period point forecasts with day/night breakdowns |
| TAF | Terminal aerodrome forecasts for airports |
| Warnings (VTEC) | Severe weather warnings, watches, and advisories |
| Radar | Regional radar imagery rendered as color-mapped thumbnails |
| QPF | Quantitative precipitation forecasts |
| Fire Weather (FWF) | Fire weather forecasts — wind, humidity, temperature |
| River/Precip (RTP) | River and precipitation reports |
| Nowcasts (NOW) | Short-term forecasts (next few hours) |

## Project Structure

```
meshwx/
  index.html          # Single-page app
  serve.js            # Zero-dependency Node.js dev server
  css/portal.css      # Styles
  js/
    app.js            # Main app controller & UI
    decoder.js        # MeshWX binary protocol decoder
    cobs.js           # COBS framing codec
    radar.js          # Radar image renderer
  data/               # Station/location lookup tables
  geo/                # GeoJSON for map layers
  vendor/
    meshcore/         # MeshCore Companion JS library
    maplibre/         # MapLibre GL JS (map rendering)
  electron/           # Electron desktop app wrapper
    main.js           # Main process (BLE/Serial permissions)
    package.json      # Build config (electron-builder)
    entitlements.plist # macOS entitlements
```

## Building the Desktop App

To build the Electron app yourself:

```bash
cd electron
npm install
npm run build:mac      # macOS (.dmg, .zip)
npm run build:win      # Windows (.exe installer + portable)
npm run build:linux    # Linux (.AppImage, .deb)
```

Cross-platform builds from macOS work for Windows and Linux. Add `-- --x64` or `-- --arm64` to target a specific architecture.

## Protocol

MeshWX uses a compact binary protocol (v4) designed for LoRa's low bandwidth. Weather data from NWS is compressed into small packets, COBS-encoded, and broadcast over MeshCore mesh channels. The JavaScript decoder in `js/decoder.js` is a port of the Swift decoder used in the [PocketMesh](https://github.com/pesqair/PocketMesh) iOS app.

## License

MIT
