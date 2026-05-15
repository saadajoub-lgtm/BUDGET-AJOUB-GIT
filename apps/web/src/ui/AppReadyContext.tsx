import { createContext, useContext } from "react";

export type AppReadyContextValue = {
  setAppReady: (ready: boolean) => void;
};

export const AppReadyContext = createContext<AppReadyContextValue>({
  setAppReady: () => {}
});

export function useAppReady() {
  return useContext(AppReadyContext);
}
