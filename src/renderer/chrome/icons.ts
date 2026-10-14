export const ICONS = {
  apps: '<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>',
  popout: '<rect x="3" y="7" width="12" height="14" rx="2"/><path d="M13 3h8v8M21 3l-9 9"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  device: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  center: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  colour: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/>',
  pin: '<path d="M12 17v5"/><path d="M9 3h6l-1 7 4 4H6l4-4z"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
} as const;

export type IconName = keyof typeof ICONS;
