import { useKumoToastManager } from "@cloudflare/kumo/components/toast";

export type ToastHandle = {
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  warning: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
};

export function useToast(): ToastHandle {
  const manager = useKumoToastManager();

  return {
    success(title, description) {
      manager.add({ title, description, variant: "success" });
    },
    error(title, description) {
      manager.add({ title, description, variant: "error" });
    },
    warning(title, description) {
      manager.add({ title, description, variant: "warning" });
    },
    info(title, description) {
      manager.add({ title, description, variant: "info" });
    },
  };
}
