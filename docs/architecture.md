# Architecture projet

## Dossiers

- `apps/api`
  - `src/server.ts` : routes REST + websocket
  - `src/db.ts` : schema SQLite + seed premier mois
  - `src/auth.ts` : JWT et middleware
- `apps/web`
  - `src/main.tsx` : bootstrap et guard auth
  - `src/ui/App.tsx` : pages principales + navigation + actions rapides
  - `src/ui/LoginPage.tsx` : connexion / inscription
  - `src/styles.css` : design responsive
- `packages/shared`
  - `src/index.ts` : types partages et constantes metier

## Flux metier principal

1. L'utilisateur se connecte (JWT stocke en local)
2. Il selectionne un mois
3. Ajout de ressources / charges
4. Changement de statut:
   - `recue` => credite le compte
   - `payee` => debite le compte
5. Paiement en espece:
   - imputation sur une charge prevue
   - debit compte `ESPECE`
   - trace dans l'historique
6. Multi-utilisateurs:
   - emission `data:changed` via Socket.IO
   - synchronisation des ecrans connectes
