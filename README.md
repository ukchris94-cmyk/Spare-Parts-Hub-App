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
- Room to plug in a real database (PostgreSQL, MongoDB, etc.).

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

- Hook the backend routes to a real database (e.g., PostgreSQL + Prisma).
- Replace mock data in mobile screens with live API calls using `axios` or `fetch`.
- Flesh out the 40+ UI screens following the existing theme and navigation patterns.
- Add proper authentication (JWT, refresh tokens) and validation.

This scaffold is intentionally minimal but opinionated, so you can iterate quickly on both the UI and backend while keeping the structure clear. If you tell me your preferred database and auth provider, I can extend the server skeleton to match.

