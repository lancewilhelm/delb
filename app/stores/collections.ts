import { defineStore } from "pinia";

export type CollectionRole = "owner" | "editor" | "viewer";

export type Collection = {
  id: string;
  name: string;
  ownerUserId: string;
  role: CollectionRole;
};

type CollectionsApiResponse = {
  success: boolean;
  data?: {
    collections?: Collection[];
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
     * Convenience for UI logic: can the current user upload/add books to this collection?
     */
    function canEditCollection(collection: Pick<Collection, "role">) {
      return collection.role === "owner" || collection.role === "editor";
    }

    function $reset() {
      collections.value = [];
      loading.value = false;
      errorMessage.value = null;
      activeSelection.value = { kind: "all" };
    }

    return {
      // state
      collections,
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
      canEditCollection,
      $reset,
    };
  },
  {
    persist: true,
  },
);
