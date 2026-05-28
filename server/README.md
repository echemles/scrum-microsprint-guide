# Microsprint Relay Server

Tiny WebSocket relay for the Microsprint OS app. Two cofounders connect to the same room and the server relays Yjs document updates between them.

## Deploy to Render (5 minutes, free)

1. Go to https://dashboard.render.com → **New +** → **Web Service**
2. Connect your GitHub account, pick the `scrum-microsprint-guide` repo
3. Configure:
   - **Name**: `microsprint-relay` (or anything)
   - **Root Directory**: `server`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: `Free`
4. Click **Create Web Service**
5. Wait ~2 min. When you see `Live`, copy the URL (e.g., `https://microsprint-relay.onrender.com`)
6. Change `https://` to `wss://` — that's your WebSocket URL: `wss://microsprint-relay.onrender.com`
7. In the Microsprint OS app, click **Join Room** → paste the URL into the new **Server URL** field → connect

## Deploy to Fly.io (also free)

```bash
cd server
flyctl launch  # follow prompts, pick "free" plan
```

## Run locally

```bash
cd server
npm install
npm start
# → ws://localhost:1234
```

## Notes

- Free tier servers (Render, Fly) **sleep after 15 min** of inactivity. First connection after sleep takes ~30 seconds to spin up.
- Data is held in memory only — when the server restarts, room state is empty. Each browser keeps its own copy in IndexedDB though, so reconnecting restores state.
- No auth: anyone with the room code can join. Use unguessable room codes for sensitive work.
