import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import AvatarExperience from './AvatarExperience.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AvatarExperience />
  </StrictMode>,
)
