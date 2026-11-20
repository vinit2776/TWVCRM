/** How a person is named to the signed-in user: "You" for themselves, their name for everyone else. */
export function personLabel(person: { id?: string | null; name?: string | null }, currentUserId: string | null | undefined): string {
  if (person.id && currentUserId && person.id === currentUserId) return "You";
  return person.name?.trim() || "Someone";
}
