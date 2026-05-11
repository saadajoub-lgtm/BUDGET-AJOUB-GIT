# Budget Mensuel

Application web de gestion de budget mensuel (PC + mobile), construite en monorepo.

## Architecture

- `apps/api` : API Express, SQLite, authentification JWT, Socket.IO realtime (legacy/transition)
- `apps/web` : Frontend React + Vite + TypeScript, Firebase Auth + Firestore sync events
- `apps/mobile` : fondation Expo React Native (Firebase + OTA via EAS Update)
- `packages/shared` : types metier partages

## Demarrage

1. Installer les dependances:

```bash
npm install
```

2. Configurer l'API:

```bash
cp apps/api/.env.example apps/api/.env
```

3. Lancer en dev:

```bash
npm run dev
```

## Configuration Firebase

1. Copier la configuration web:

```bash
cp apps/web/.env.example apps/web/.env
```

2. Renseigner les variables Firebase `VITE_FIREBASE_*`.

3. Initialiser et deployer Firebase:

```bash
npm run firebase:init
npm run deploy:firestore
npm run deploy:web
```

## Migration vers Firestore

Script de migration (dry-run par defaut):

```bash
npm run migrate-firestore -w apps/api
```

Importer reellement vers Firestore:

```bash
npm run migrate-firestore -w apps/api -- --budget=default-budget --out=./migration-backup.json
tsx apps/api/scripts/migrate-to-firestore.ts --budget=default-budget --out=./migration-backup.json
```

## Mobile (Expo + OTA)

```bash
npm install -w apps/mobile
npm run dev -w apps/mobile
npm run eas:update -w apps/mobile
```

## Pages

- Connexion
- Tableau de bord
- Comptes
- Ressources
- Charges
- Historique des depenses
- Parametres

## Fonctionnalites incluses (MVP)

- Comptes predefinis
- Ressources (prevue/recue)
- Charges (prevue/payee)
- Paiement en espece (imputation sur charge + debit compte ESPECE)
- Gestion mensuelle avec creation de mois
- Copie des charges vers mois suivant (optionnelle)
- Session persistante via token localStorage
- Synchronisation temps reel entre utilisateurs connectes
