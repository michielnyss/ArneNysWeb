import type { CollectionEntry } from 'astro:content';

type Artwork = CollectionEntry<'artworks'>;

/** The order the live grid uses: the collection's own sequence. */
export function sortArtworks(artworks: Artwork[]): Artwork[] {
  return [...artworks].sort(
    (a, b) => a.data.order - b.data.order || a.data.title.localeCompare(b.data.title),
  );
}

export function yearsOf(artworks: Artwork[]): number[] {
  const years = new Set<number>();
  for (const a of artworks) if (a.data.year != null) years.add(a.data.year);
  return [...years].sort((a, b) => b - a);
}
