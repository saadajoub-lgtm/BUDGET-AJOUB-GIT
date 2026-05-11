# Firebase cutover checklist

## Auth
- [ ] Register user works on `/register`
- [ ] Login works on `/login`
- [ ] Password reset email works on `/reset-password`
- [ ] Session stays connected after browser restart

## Collaboration
- [ ] Two users connected to same `budgetId` see refreshes in real time
- [ ] Owner can invite a member by email (Firestore members collection)
- [ ] Member access is allowed by Firestore rules

## Business logic
- [ ] Month switch keeps data consistency
- [ ] Dashboard values match legacy logic
- [ ] Paid charges do not reappear as planned
- [ ] Resources and charges stay in their real month (`YYYY-MM-DD`)

## Deploy
- [ ] `npm run build` succeeds for API and web
- [ ] `npm run deploy:firestore` succeeds
- [ ] `npm run deploy:web` succeeds

## Mobile foundation
- [ ] Expo app boots with Firebase config
- [ ] Login works in mobile shell
- [ ] `npm run eas:update -w apps/mobile` runs with configured project
