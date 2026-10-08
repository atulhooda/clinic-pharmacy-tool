import { IconToday, IconBox, IconTruck, IconSliders, IconSettings } from '@/components/ui/icons';
import type { IconKey } from '@/lib/nav';

export const SHELL_ICONS: Record<IconKey, (p: { className?: string }) => JSX.Element> = {
  today: IconToday, box: IconBox, truck: IconTruck, sliders: IconSliders, settings: IconSettings,
};
