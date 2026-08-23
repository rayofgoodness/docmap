export interface SectionLabels {
  purpose: string;
  responsibilities: string;
  businessLogic: string;
  invariants: string;
  inputsOutputs: string;
  relationships: string;
  briefWhatItDoes: string;
  briefKeyScenarios: string;
  briefBusinessRules: string;
  briefWhatToCheck: string;
  briefDependencyRisks: string;
}

const CATALOG: Record<string, SectionLabels> = {
  en: {
    purpose: 'Purpose',
    responsibilities: 'Responsibilities',
    businessLogic: 'Business Logic',
    invariants: 'Invariants',
    inputsOutputs: 'Inputs / Outputs',
    relationships: 'Relationships',
    briefWhatItDoes: 'What this module does',
    briefKeyScenarios: 'Key scenarios',
    briefBusinessRules: 'Business rules',
    briefWhatToCheck: 'What to check after changes',
    briefDependencyRisks: 'Dependency risks',
  },
  uk: {
    purpose: 'Призначення',
    responsibilities: 'Відповідальність',
    businessLogic: 'Бізнес-логіка',
    invariants: 'Інваріанти',
    inputsOutputs: 'Входи / Виходи',
    relationships: 'Звʼязки',
    briefWhatItDoes: 'Що робить модуль',
    briefKeyScenarios: 'Ключові сценарії',
    briefBusinessRules: 'Бізнес-правила',
    briefWhatToCheck: 'Що перевірити після змін',
    briefDependencyRisks: 'Ризики залежностей',
  },
};

export function getSectionLabels(lang: string): SectionLabels {
  return CATALOG[lang] ?? CATALOG.en!;
}
