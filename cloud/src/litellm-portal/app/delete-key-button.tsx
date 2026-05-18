import React, { useCallback, useState } from "react";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Text } from "@cloudflare/kumo/components/text";
import { useDeleteKey } from "../hooks/use-delete-key";
import { PortalKey, keyLabel, deleteKeyErrorMessage } from "./utils";

export function DeleteKeyButton({
  apiKey,
}: {
  apiKey: PortalKey;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyId = typeof apiKey.id === "string" ? apiKey.id : "";
  const label = keyLabel(apiKey);
  const deleteKey = useDeleteKey();

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setError(null);
    }
  }, []);

  const handleDelete = useCallback(async () => {
    if (!keyId) {
      setError("缺少要删除的 Key ID。");
      return;
    }
    setError(null);
    deleteKey.mutate(keyId, {
      onSuccess: () => { setOpen(false); },
      onError: (err: unknown) => {
        setError(deleteKeyErrorMessage(err));
      },
    });
  }, [keyId, deleteKey]);

  return (
    <Dialog.Root role="alertdialog" open={open} onOpenChange={handleOpenChange}>
      <Dialog.Trigger
        render={(props) => (
          <Button {...props} variant="secondary-destructive" size="xs" disabled={!keyId}>
            删除
          </Button>
        )}
      />
      <Dialog size="sm" className="space-y-5 p-6">
        <Dialog.Title>
          <Text variant="heading3" as="h2">删除 API Key？</Text>
        </Dialog.Title>
        <Dialog.Description>
          <Text variant="secondary">将删除「{label}」。删除后该 Key 会立即失效，此操作不可撤销。</Text>
        </Dialog.Description>
        {error ? (
          <Banner variant="error" title="删除失败" description={error} />
        ) : null}
        <div className="flex justify-end gap-2">
          <Dialog.Close
            render={(props) => (
              <Button {...props} variant="secondary" size="sm" disabled={deleteKey.isPending}>
                取消
              </Button>
            )}
          />
          <Button variant="destructive" size="sm" loading={deleteKey.isPending} onClick={handleDelete}>
            确认删除
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
