export type TbrBook = {
  id: string;
  title: string;
  description: string | null;
  coverThumbnailUrl: string | null;
  rank: number;
  rationale: string;
  authors: { id: string; name: string }[];
};
