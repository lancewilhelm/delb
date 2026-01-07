import { defineStore } from "pinia";

export type CollectionRole = "owner" | "editor" | "viewer";

export type Collection = {
  id: string;
  name: string;
  ownerUserId: string;
  role: CollectionRole;

  /**
   * Marks a user's default Personal collection.
   * - visible like any other collection
   * - non-deletable / non-shareable (enforced by UI + API)
   */
  isPersonal: boolean;
};

export type CollectionMember = {
  userId: string;
  email?: string | null;
  role: CollectionRole;
};

type CollectionsApiResponse = {
  success: boolean;
  data?: {
    collections?: Collection[];
  };
  message?: string;
};

type UpdateCollectionApiResponse = {
  success: boolean;
  data?: {
    collection?: Pick<Collection, "id" | "name">;
  };
  message?: string;
};

type CollectionMembersApiResponse = {
  success: boolean;
  data?: {
    members?: CollectionMember[];
  };
  message?: string;
};

type UpsertCollectionMemberApiResponse = {
  success: boolean;
  data?: {
    member?: CollectionMember;
  };
  message?: string;
};

type RemoveCollectionMemberApiResponse = {
  success: boolean;
  message?: string;
};

type DeleteCollectionApiResponse = {
  success: boolean;
  message?: string;
};

type LeaveCollectionApiResponse = {
  success: boolean;
  data?: {
    left?: boolean;
  };
  message?: string;
};

type TransferOwnershipApiResponse = {
  success: boolean;
  data?: {
    ownerUserId?: string;
  };
  message?: string;
};

export type ActiveCollectionSelection =
  | { kind: "all" }
  | { kind: "collection"; collectionId: string };

export const useCollectionsStore = defineStore(
  "collections",
  () => {
    const collections = ref<Collection[]>([]);
    const loading = ref(false);
    const errorMessage = ref<string | null>(null);

    // Simple per-collection member cache for the edit modal.
    const membersByCollectionId = ref<Record<string, CollectionMember[]>>({});

    // "All" means: show books from all collections the user is a member of.
    // Otherwise, a specific collection governs the visible books list.
    const activeSelection = ref<ActiveCollectionSelection>({ kind: "all" });

    const activeCollectionId = computed(() => {
      const sel = activeSelection.value;
      if (sel.kind === "collection") return sel.collectionId;
      return null;
    });

    const activeCollection = computed(() => {
      const sel = activeSelection.value;
      if (sel.kind !== "collection") return null;

      return collections.value.find((c) => c.id === sel.collectionId) ?? null;
    });

    function setActiveAll() {
      activeSelection.value = { kind: "all" };
    }

    function setActiveCollection(collectionId: string) {
      activeSelection.value = { kind: "collection", collectionId };
    }

    async function fetchCollections() {
      loading.value = true;
      errorMessage.value = null;

      try {
        const res = await $fetch<CollectionsApiResponse>("/api/collections", {
          method: "GET",
        });

        collections.value = res?.data?.collections ?? [];

        // If the user had a specific collection selected and it no longer exists,
        // fall back to "All".
        if (activeSelection.value.kind === "collection") {
          const sel = activeSelection.value;
          if (!collections.value.some((c) => c.id === sel.collectionId)) {
            setActiveAll();
          }
        }
      } catch (err: unknown) {
        const e = err as {
          data?: { message?: string };
          message?: string;
          statusMessage?: string;
        };
        errorMessage.value =
          e?.data?.message ||
          e?.statusMessage ||
          e?.message ||
          "Failed to load collections";
      } finally {
        loading.value = false;
      }
    }

    /**
     * Updates a collection's name.
     * This enforces "owner/editor" on the server; client should still gate the UI.
     */
    async function updateCollectionName(collectionId: string, name: string) {
      const trimmed = (name ?? "").trim();
      if (!trimmed) {
        throw new Error("Collection name is required");
      }
      if (trimmed.length > 120) {
        throw new Error("Collection name is too long");
      }

      const res = await $fetch<UpdateCollectionApiResponse>(
        `/api/collections/${encodeURIComponent(collectionId)}`,
        {
          method: "PUT",
          body: { name: trimmed },
        },
      );

      const updated = res?.data?.collection;
      if (!updated?.id) {
        throw new Error(res?.message || "Failed to update collection");
      }

      const idx = collections.value.findIndex((c) => c.id === updated.id);
      if (idx !== -1) {
        collections.value[idx] = {
          ...collections.value[idx]!,
          name: updated.name,
        };
      }

      return updated;
    }

    /**
     * Lists members for a collection (for the Edit Collection modal).
     * Expected endpoint: GET /api/collections/:id/members
     */
    async function fetchCollectionMembers(collectionId: string) {
      const res = await $fetch<CollectionMembersApiResponse>(
        `/api/collections/${encodeURIComponent(collectionId)}/members`,
        { method: "GET" },
      );

      const members = res?.data?.members ?? [];
      membersByCollectionId.value = {
        ...membersByCollectionId.value,
        [collectionId]: members,
      };

      return members;
    }

    /**
     * Adds a member or updates their role.
     * Expected endpoint: PUT /api/collections/:id/members
     */
    async function upsertCollectionMember(opts: {
      collectionId: string;
      email: string;
      role: CollectionRole;
    }) {
      const email = (opts.email ?? "").trim().toLowerCase();
      if (!email) throw new Error("Email is required");

      const res = await $fetch<UpsertCollectionMemberApiResponse>(
        `/api/collections/${encodeURIComponent(opts.collectionId)}/members`,
        {
          method: "PUT",
          body: { email, role: opts.role },
        },
      );

      const updated = res?.data?.member;
      if (!updated?.userId) {
        throw new Error(res?.message || "Failed to update member");
      }

      const existing = membersByCollectionId.value[opts.collectionId] ?? [];
      const idx = existing.findIndex((m) => m.userId === updated.userId);

      const nextMember: CollectionMember =
        idx === -1
          ? { ...updated, email }
          : { ...existing[idx]!, ...updated, email };

      const next =
        idx === -1
          ? [...existing, nextMember]
          : [...existing.slice(0, idx), nextMember, ...existing.slice(idx + 1)];

      membersByCollectionId.value = {
        ...membersByCollectionId.value,
        [opts.collectionId]: next,
      };

      return nextMember;
    }

    /**
     * Removes a member from a collection.
     * Expected endpoint: DELETE /api/collections/:id/members/:userId
     */
    async function removeCollectionMember(opts: {
      collectionId: string;
      userId: string;
    }) {
      const userId = (opts.userId ?? "").trim();
      if (!userId) throw new Error("User id is required");

      const res = await $fetch<RemoveCollectionMemberApiResponse>(
        `/api/collections/${encodeURIComponent(opts.collectionId)}/members/${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      );

      if (!res?.success) {
        throw new Error(res?.message || "Failed to remove member");
      }

      const existing = membersByCollectionId.value[opts.collectionId] ?? [];
      membersByCollectionId.value = {
        ...membersByCollectionId.value,
        [opts.collectionId]: existing.filter((m) => m.userId !== userId),
      };

      return true;
    }

    /**
     * Allows the current user to remove themselves from a collection,
     * as long as they are not the owner.
     *
     * Expected endpoint: POST /api/collections/:id/leave
     */
    async function leaveCollection(collectionId: string) {
      const res = await $fetch<LeaveCollectionApiResponse>(
        `/api/collections/${encodeURIComponent(collectionId)}/leave`,
        { method: "POST" },
      );

      if (!res?.success) {
        throw new Error(res?.message || "Failed to leave collection");
      }

      // Membership is gone, so refresh the list.
      await fetchCollections();

      // Best-effort cleanup of cached members
      const nextMembers = Object.fromEntries(
        Object.entries(membersByCollectionId.value).filter(
          ([id]) => id !== collectionId,
        ),
      );
      membersByCollectionId.value = nextMembers;

      if (
        activeSelection.value.kind === "collection" &&
        activeSelection.value.collectionId === collectionId
      ) {
        setActiveAll();
      }

      return Boolean(res?.data?.left);
    }

    /**
     * Transfers collection ownership to the user with the given email.
     * After transfer:
     * - the target becomes the *sole* owner
     * - the previous owner becomes an editor
     *
     * Expected endpoint: POST /api/collections/:id/transfer-ownership
     */
    async function transferCollectionOwnership(opts: {
      collectionId: string;
      email: string;
    }) {
      const email = (opts.email ?? "").trim().toLowerCase();
      if (!email) throw new Error("Email is required");

      const res = await $fetch<TransferOwnershipApiResponse>(
        `/api/collections/${encodeURIComponent(opts.collectionId)}/transfer-ownership`,
        { method: "POST", body: { email } },
      );

      if (!res?.success) {
        throw new Error(res?.message || "Failed to transfer ownership");
      }

      // Ownership affects permissions and visible UI, so refresh.
      await fetchCollections();

      // Members/roles likely changed; refresh cache for the modal if necessary.
      await fetchCollectionMembers(opts.collectionId);

      return res?.data?.ownerUserId ?? null;
    }

    /**
     * Deletes a collection (owner-only on server).
     * Expected endpoint: DELETE /api/collections/:id
     *
     * NOTE: Personal collections must not be deletable; server should enforce.
     */
    async function deleteCollection(collectionId: string) {
      const res = await $fetch<DeleteCollectionApiResponse>(
        `/api/collections/${encodeURIComponent(collectionId)}`,
        { method: "DELETE" },
      );

      if (!res?.success) {
        throw new Error(res?.message || "Failed to delete collection");
      }

      // Update local state eagerly
      collections.value = collections.value.filter(
        (c) => c.id !== collectionId,
      );
      const nextMembers = Object.fromEntries(
        Object.entries(membersByCollectionId.value).filter(
          ([id]) => id !== collectionId,
        ),
      );
      membersByCollectionId.value = nextMembers;

      if (
        activeSelection.value.kind === "collection" &&
        activeSelection.value.collectionId === collectionId
      ) {
        setActiveAll();
      }

      return true;
    }

    /**
     * Convenience for UI logic: can the current user upload/add books to this collection?
     */
    function canEditCollection(collection: Pick<Collection, "role">) {
      // owner/editor can rename (and later: manage books)
      return collection.role === "owner" || collection.role === "editor";
    }

    /**
     * Convenience for UI logic: can the current user manage sharing/members?
     * v1: owner and editor can add/remove members (but not remove self-owner; see API)
     */
    function canManageMembers(collection: Pick<Collection, "role">) {
      return collection.role === "owner" || collection.role === "editor";
    }

    /**
     * Convenience for UI logic: can the current user transfer ownership?
     * v1: owner-only.
     */
    function canTransferOwnership(
      collection: Pick<Collection, "role" | "isPersonal">,
    ) {
      if (collection.isPersonal) return false;
      return collection.role === "owner";
    }

    /**
     * Convenience for UI logic: can the current user delete this collection?
     * v1: owner-only (Personal must be blocked server-side too).
     */
    function canDeleteCollection(
      collection: Pick<Collection, "role" | "isPersonal">,
    ) {
      if (collection.isPersonal) return false;
      return collection.role === "owner";
    }

    function $reset() {
      collections.value = [];
      membersByCollectionId.value = {};
      loading.value = false;
      errorMessage.value = null;
      activeSelection.value = { kind: "all" };
    }

    return {
      // state
      collections,
      membersByCollectionId,
      loading,
      errorMessage,
      activeSelection,

      // derived
      activeCollectionId,
      activeCollection,

      // actions
      setActiveAll,
      setActiveCollection,
      fetchCollections,
      updateCollectionName,

      fetchCollectionMembers,
      upsertCollectionMember,
      removeCollectionMember,
      leaveCollection,
      transferCollectionOwnership,
      deleteCollection,

      canEditCollection,
      canManageMembers,
      canTransferOwnership,
      canDeleteCollection,
      $reset,
    };
  },
  {
    persist: true,
  },
);
