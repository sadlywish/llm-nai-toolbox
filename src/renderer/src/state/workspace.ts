import { create } from 'zustand'
import { emptyValues, type FieldValues } from '@shared/blockDoc'
import { CHARACTER_FIELDS, MAIN_FIELDS } from '@shared/fields'

interface WorkspaceState {
  main: FieldValues
  character: FieldValues
  setMain: (values: FieldValues) => void
  setCharacter: (values: FieldValues) => void
}

export const useWorkspace = create<WorkspaceState>((set) => ({
  main: emptyValues(MAIN_FIELDS),
  character: emptyValues(CHARACTER_FIELDS),
  setMain: (values) => set({ main: values }),
  setCharacter: (values) => set({ character: values }),
}))
