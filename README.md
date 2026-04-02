# SpareParts Hub

SpareParts Hub is a role‑based marketplace for auto spare parts, built with a **React Native** frontend and a **Node.js (Express)** backend.

The app targets four primary user types:

- Mechanic
- Vendor
- Dispatcher
- Regular User

All roles share the same dark theme UI; screens and flows differ slightly per role (especially during sign‑up and in the home dashboard).

---

## Monorepo Structure

```text
.
├── mobile/      # React Native app (Expo-style)
└── server/      # Node.js / Express API
```

### `mobile/` (React Native)

Key points:

- Expo‑style React Native app for fast iteration.
- React Navigation for screen flows.
- Centralized dark theme (no orange hue) with reusable components.
- Role‑aware navigation (mechanic, vendor, dispatcher, regular user).

Important files:

- `mobile/App.tsx` – App entry; sets up navigation and theme.
- `mobile/src/theme/colors.ts` – Dark theme palette shared across screens.
- `mobile/src/navigation/RootNavigator.tsx` – Stack/tab navigation.
- `mobile/src/screens/Auth/*` – Role selection, sign‑up, login, verification.
- `mobile/src/screens/Home/*` – Role‑specific dashboards.

### `server/` (Node.js backend)

Key points:

- Express app in TypeScript, easy to extend.
- Basic routing split by domain: auth, users, parts, orders.
- PostgreSQL for users, verification codes, orders, and parts; pino for structured logging.

Important files:

- `server/src/server.ts` – Express app bootstrap.
- `server/src/routes/auth.ts` – Auth and role‑based sign‑up endpoints.
- `server/src/routes/parts.ts` – Parts search and request endpoints (skeleton).
- `server/src/routes/orders.ts` – Order and delivery tracking endpoints (skeleton).

---

## Getting Started

> These steps assume you have **Node.js ≥ 18** and **npm** or **yarn** installed.

### 1. Install dependencies

From the project root:

```bash
cd mobile
npm install   # or: yarn

cd ../server
npm install   # or: yarn
```

### 2. Run the backend (server)

```bash
cd server
npm run dev
```

This starts the Express API (default: `http://localhost:4000`).

**Database and logging:** The API uses **PostgreSQL** for users, verification codes, orders, and parts. Set `DATABASE_URL` in `server/.env` (see `server/.env.example`). Then run the schema once:

```bash
cd server
npm run migrate
```

All HTTP requests and key events (signup, login, verify, errors) are logged with **pino**. In production with PM2 you’ll see JSON lines in `~/.pm2/logs/`; use `pm2 logs` to tail them.

### 3. Run the mobile app

```bash
cd mobile
npm start
```

This starts the Expo dev server; you can use:

- `a` for Android emulator
- `i` for iOS simulator
- `w` for web preview (limited RN support)

---

## High‑Level Flows

### Authentication & Onboarding

- **Role selection**: user chooses _Mechanic_, _Vendor_, _Dispatcher_, or _Regular User_.
- **Role‑specific sign‑up**:
  - All: name, email, phone, password, city.
  - Mechanic: workshop details, services, preferred brands.
  - Vendor: shop name, business type, categories, payout setup (later).
  - Dispatcher: vehicle types, radius, availability.
  - Regular: basic profile; vehicles can be added later.
- **Verification**: email/OTP code entry.
- **Login**: standard email/password form + social placeholders.

### Core Screens (mobile)

- Role‑based home dashboards (Mechanic/Vendor/Dispatcher/User).
- Search for parts with filters (vehicle, category, distance, price).
- Part detail screen with compatibility and vendor info.
- Cart and checkout (skeleton).
- Requests: post a part request, receive vendor offers (skeleton).
- Orders & delivery tracking (skeleton).
- Profile & settings: vehicles, payout, notifications, theme.

---

## Extending the App

Recommended next steps:

- The backend uses PostgreSQL (see `server/src/db/schema.sql` and `npm run migrate`). You can add an ORM (e.g. Prisma) later if you prefer.
- Replace mock data in mobile screens with live API calls using `axios` or `fetch`.
- Flesh out the 40+ UI screens following the existing theme and navigation patterns.
- Add proper authentication (JWT, refresh tokens) and validation.

This scaffold is intentionally minimal but opinionated, so you can iterate quickly on both the UI and backend while keeping the structure clear. If you tell me your preferred database and auth provider, I can extend the server skeleton to match.

---

## Client Demo Runbook (Current Build)

### 1) Deploy and verify API

```bash
cd server
npm run migrate
npm run build
pm2 restart spare-parts-hub
curl http://<SERVER_IP>/api/health
```

### 2) First-name greeting (no email on homepage)

- `POST /api/auth/signup` now accepts `firstName` and stores it.
- `POST /api/auth/login` returns `firstName`.
- `GET /api/home/user` now returns `userName` as first name (fallback: parsed cleanly from email prefix).

Quick check:

```bash
curl -X POST http://<SERVER_IP>/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"role":"user","email":"jane.doe@example.com","password":"StrongPass123","firstName":"Jane"}'
```

Then verify and login, then:

```bash
curl "http://<SERVER_IP>/api/home/user"
```

### 3) Towing service quote demo

```bash
curl -X POST http://<SERVER_IP>/api/services/towing/quote \
  -H "Content-Type: application/json" \
  -d '{"distanceKm":42,"priority":"urgent","vehicleType":"suv","isRemote":true}'
```

### 4) Mechanic repair pricing demo

```bash
curl -X POST http://<SERVER_IP>/api/services/mechanic/quote \
  -H "Content-Type: application/json" \
  -d '{"serviceType":"brake-repair","laborHours":2.5,"partsCost":48000,"isRemote":false,"complexity":"medium"}'
```

### 5) Demo flow for client presentation

1. Sign up as a `user` with `firstName`.
2. Verify email code and log in.
3. Open home dashboard and show `Hello, <FirstName>`.
4. Add vehicle and refresh home.
5. Open “Quick service picks”.
6. Show towing quote (`/api/services/towing/quote`).
7. Show mechanic quote (`/api/services/mechanic/quote`).

### Optional: login button lag checks

- On mobile, disable login button while request is in-flight (`isLoading`) to prevent duplicate taps.
- Ensure frontend API URL points to the backend root (`.../api`) and not a nested path.
- Clear Metro cache once before demo:

```bash
cd mobile
npx expo start -c
```
