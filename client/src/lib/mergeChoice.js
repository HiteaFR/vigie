// EFFECTIVE selection of "Merge with…": the chosen record if it is SHOWN; otherwise, if a
// single result is shown, that one; otherwise null: a record the user cannot see is never
// sent. Pure code.
export function mergeChoice(shown, chosenId) {
  const id = chosenId == null || chosenId === '' ? null : Number(chosenId)
  const chosen = id == null ? null : shown.find(x => x.id === id)
  if (chosen) return chosen
  if (shown.length === 1) return shown[0]
  return null
}
