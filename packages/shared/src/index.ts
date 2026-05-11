export const ACCOUNT_NAMES = [
  "BANK OF AFRICA",
  "SAHAM BANK",
  "CDM MELANIE",
  "CDM SAAD 1",
  "CDM SAAD 2",
  "ESPECE",
  "EPARGNE"
] as const;

export const RESOURCE_TYPES = [
  "Salaire Saad",
  "Salaire Melanie",
  "CAF",
  "Prime",
  "Autres"
] as const;

export type AccountName = (typeof ACCOUNT_NAMES)[number];
export type ResourceType = (typeof RESOURCE_TYPES)[number];
export type ItemStatus = "prevue" | "recue" | "payee";

export interface BudgetMonth {
  id: string;
  label: string;
  startsAt: string;
  endsAt: string;
}

export interface Account {
  id: string;
  monthId: string;
  name: AccountName;
  balanceCents: number;
}

export interface Resource {
  id: string;
  monthId: string;
  type: ResourceType;
  amountCents: number;
  accountId: string;
  expectedDate: string;
  status: "prevue" | "recue";
}

export interface Charge {
  id: string;
  monthId: string;
  label: string;
  category: string;
  amountCents: number;
  paidCents: number;
  accountId: string;
  expectedDate: string;
  status: "prevue" | "payee";
}
