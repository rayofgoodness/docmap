export interface SectionLabels {
  purpose: string;
  responsibilities: string;
  businessLogic: string;
  invariants: string;
  inputsOutputs: string;
  relationships: string;
}

const CATALOG: Record<string, SectionLabels> = {
  en: {
    purpose: 'Purpose',
    responsibilities: 'Responsibilities',
    businessLogic: 'Business Logic',
    invariants: 'Invariants',
    inputsOutputs: 'Inputs / Outputs',
    relationships: 'Relationships',
  },
  uk: {
    purpose: 'Призначення',
    responsibilities: 'Відповідальність',
    businessLogic: 'Бізнес-логіка',
    invariants: 'Інваріанти',
    inputsOutputs: 'Входи / Виходи',
    relationships: 'Звʼязки',
  },
};

export function getSectionLabels(lang: string): SectionLabels {
  return CATALOG[lang] ?? CATALOG.en!;
}
