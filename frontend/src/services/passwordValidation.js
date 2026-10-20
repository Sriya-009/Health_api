const PASSWORD_RULES = [
  { key: 'minLength', label: 'At least 8 characters', test: (password) => password.length >= 8 },
  { key: 'uppercase', label: 'At least one uppercase letter', test: (password) => /[A-Z]/.test(password) },
  { key: 'lowercase', label: 'At least one lowercase letter', test: (password) => /[a-z]/.test(password) },
  { key: 'number', label: 'At least one number', test: (password) => /[0-9]/.test(password) },
  { key: 'special', label: 'At least one special character', test: (password) => /[^A-Za-z0-9]/.test(password) },
];

export function getPasswordValidation(password = '') {
  const value = String(password);
  const rules = Object.fromEntries(PASSWORD_RULES.map(({ key, test }) => [key, test(value)]));
  const passedRules = Object.values(rules).filter(Boolean).length;
  const strength = passedRules === 5 ? 'Strong' : passedRules >= 4 ? 'Good' : passedRules >= 2 ? 'Fair' : 'Weak';
  return { rules, valid: passedRules === PASSWORD_RULES.length, strength, passedRules };
}

export function getPasswordRequirements() {
  return PASSWORD_RULES.map(({ key, label }) => ({ key, label }));
}
