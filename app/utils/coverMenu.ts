type CoverMenuItemBase = {
  key: string;
  label?: string;
  disabled?: boolean;
  checked?: boolean;
};

export type CoverMenuItem =
  | (CoverMenuItemBase & { to: string; onSelect?: never; children?: never })
  | (CoverMenuItemBase & {
      onSelect: () => void | Promise<void>;
      to?: never;
      children?: never;
    })
  | (CoverMenuItemBase & {
      label: string;
      children: CoverMenuItem[];
      to?: never;
      onSelect?: never;
    });
