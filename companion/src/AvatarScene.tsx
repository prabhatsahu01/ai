import { useEffect, useRef, type MutableRefObject } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

export type AvatarActivity = 'ready' | 'listening' | 'thinking' | 'speaking'

type AvatarSceneProps = {
  activity: AvatarActivity
  speakingRef: MutableRefObject<boolean>
  speechMotionRef: MutableRefObject<number>
}

function addSphere(
  parent: THREE.Object3D,
  position: THREE.Vector3,
  scale: THREE.Vector3,
  material: THREE.Material,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 32), material)
  mesh.position.copy(position)
  mesh.scale.copy(scale)
  parent.add(mesh)
  return mesh
}

function addCurve(
  parent: THREE.Object3D,
  points: THREE.Vector3[],
  radius: number,
  material: THREE.Material,
): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(points)
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, radius, 8, false), material)
  parent.add(mesh)
  return mesh
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    child.geometry.dispose()
    const materials = Array.isArray(child.material) ? child.material : [child.material]
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose()
      }
      material.dispose()
    }
  })
}

function createSkinBumpMap(): THREE.DataTexture {
  const size = 128
  const pixels = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const grain = 122 + (((Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0) % 13)
      const offset = (y * size + x) * 4
      pixels[offset] = grain
      pixels[offset + 1] = grain
      pixels[offset + 2] = grain
      pixels[offset + 3] = 255
    }
  }

  const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(2, 2)
  texture.needsUpdate = true
  return texture
}

function createFaceGeometry(): THREE.SphereGeometry {
  const geometry = new THREE.SphereGeometry(1, 64, 48)
  const positions = geometry.getAttribute('position')
  for (let index = 0; index < positions.count; index += 1) {
    const vertical = positions.getY(index)
    const jawWidth = 0.92 + 0.08 * THREE.MathUtils.smoothstep(vertical, -0.72, 0.12)
    positions.setX(index, positions.getX(index) * 0.68 * jawWidth)
    positions.setY(index, vertical * 0.88)
    positions.setZ(index, positions.getZ(index) * 0.56)
  }
  positions.needsUpdate = true
  geometry.computeVertexNormals()
  return geometry
}

function createHeadPivot(mesh: THREE.Mesh): THREE.Group | null {
  const geometry = mesh.geometry
  const position = geometry.getAttribute('position')
  const sourceIndex = geometry.index
  if (!position || !sourceIndex || sourceIndex.count < 3) return null

  geometry.computeBoundingBox()
  const bounds = geometry.boundingBox
  if (!bounds) return null
  const threshold = bounds.max.y - (bounds.max.y - bounds.min.y) * 0.3
  const vertexIndex = sourceIndex.array

  function isHeadTriangle(index: number) {
    return position.getY(vertexIndex[index]) >= threshold
      && position.getY(vertexIndex[index + 1]) >= threshold
      && position.getY(vertexIndex[index + 2]) >= threshold
  }

  let headIndexCount = 0
  for (let index = 0; index < sourceIndex.count; index += 3) {
    if (isHeadTriangle(index)) headIndexCount += 3
  }
  if (!headIndexCount || headIndexCount === sourceIndex.count) return null

  const headIndices = new Uint32Array(headIndexCount)
  const bodyIndices = new Uint32Array(sourceIndex.count - headIndexCount)
  let headOffset = 0
  let bodyOffset = 0
  for (let index = 0; index < sourceIndex.count; index += 3) {
    const isHead = isHeadTriangle(index)
    const target = isHead ? headIndices : bodyIndices
    const offset = isHead ? headOffset : bodyOffset
    target[offset] = vertexIndex[index]
    target[offset + 1] = vertexIndex[index + 1]
    target[offset + 2] = vertexIndex[index + 2]
    if (isHead) headOffset += 3
    else bodyOffset += 3
  }

  function createSubset(indices: Uint32Array) {
    const subset = new THREE.BufferGeometry()
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
      subset.setAttribute(name, attribute)
    }
    subset.setIndex(new THREE.BufferAttribute(indices, 1))
    return subset
  }

  const parent = mesh.parent
  if (!parent) return null
  mesh.updateMatrix()
  const pivot = new THREE.Group()
  pivot.name = 'procedural-head-gesture'
  const pivotMatrix = mesh.matrix.clone().multiply(
    new THREE.Matrix4().makeTranslation(0, threshold, 0),
  )
  pivotMatrix.decompose(pivot.position, pivot.quaternion, pivot.scale)

  const head = new THREE.Mesh(createSubset(headIndices), mesh.material)
  head.position.y = -threshold
  head.castShadow = mesh.castShadow
  head.receiveShadow = mesh.receiveShadow
  pivot.add(head)

  mesh.geometry = createSubset(bodyIndices)
  parent.add(pivot)
  geometry.dispose()
  return pivot
}

function createAvatar() {
  const root = new THREE.Group()
  const head = new THREE.Group()
  const eyes: THREE.Group[] = []
  const brows: THREE.Group[] = []
  const skin = new THREE.MeshPhysicalMaterial({
    color: 0xd0aa91,
    roughness: 0.7,
    bumpMap: createSkinBumpMap(),
    bumpScale: 0.012,
    clearcoat: 0.05,
    clearcoatRoughness: 0.82,
  })
  const shadow = new THREE.MeshStandardMaterial({ color: 0x211719, roughness: 0.68 })
  const hair = new THREE.MeshStandardMaterial({ color: 0x493326, roughness: 0.42, metalness: 0.04 })
  const hairLight = new THREE.MeshStandardMaterial({ color: 0x927052, roughness: 0.46, metalness: 0.02 })
  const cloth = new THREE.MeshStandardMaterial({ color: 0x191719, roughness: 0.84 })
  const brass = new THREE.MeshStandardMaterial({ color: 0xa98d69, metalness: 0.72, roughness: 0.35 })
  const eyeWhite = new THREE.MeshStandardMaterial({ color: 0xd6c4b5, roughness: 0.42 })
  const iris = new THREE.MeshStandardMaterial({ color: 0x513432, roughness: 0.3 })
  const pupil = new THREE.MeshStandardMaterial({ color: 0x100e10, roughness: 0.18 })
  const lip = new THREE.MeshStandardMaterial({ color: 0x805b5c, roughness: 0.48 })

  addSphere(
    root,
    new THREE.Vector3(0, 0.37, 0),
    new THREE.Vector3(0.98, 0.5, 0.46),
    cloth,
  )
  addSphere(root, new THREE.Vector3(0, -0.13, 0), new THREE.Vector3(0.67, 0.74, 0.42), cloth)
  addCurve(
    root,
    [
      new THREE.Vector3(-0.49, 0.7, 0.42),
      new THREE.Vector3(-0.24, 0.47, 0.51),
      new THREE.Vector3(0, 0.37, 0.54),
      new THREE.Vector3(0.24, 0.47, 0.51),
      new THREE.Vector3(0.49, 0.7, 0.42),
    ],
    0.012,
    brass,
  )

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.24, 0.66, 32), skin)
  neck.position.set(0, 1.03, 0)
  root.add(neck)

  addSphere(root, new THREE.Vector3(0, 0.37, 0.54), new THREE.Vector3(0.035, 0.055, 0.025), brass)

  head.position.y = 1.84
  root.add(head)
  addSphere(head, new THREE.Vector3(0, 0, -0.15), new THREE.Vector3(0.77, 1.04, 0.6), hair)
  const face = new THREE.Mesh(createFaceGeometry(), skin)
  face.position.y = 0.03
  head.add(face)

  const hairCap = new THREE.Mesh(
    new THREE.SphereGeometry(0.82, 48, 32, 0, Math.PI * 2, 0, Math.PI * 0.27),
    hair,
  )
  hairCap.scale.set(1, 1, 0.9)
  hairCap.position.set(0, 0.1, 0.1)
  head.add(hairCap)

  for (const side of [-1, 1]) {
    const eye = new THREE.Group()
    eye.position.set(side * 0.265, -0.055, 0.495)
    addSphere(eye, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.11, 0.048, 0.042), eyeWhite)
    addSphere(eye, new THREE.Vector3(-side * 0.006, 0, 0.038), new THREE.Vector3(0.035, 0.038, 0.018), iris)
    addSphere(eye, new THREE.Vector3(-side * 0.006, 0, 0.052), new THREE.Vector3(0.016, 0.022, 0.01), pupil)
    addSphere(eye, new THREE.Vector3(-0.014, 0.016, 0.076), new THREE.Vector3(0.008, 0.009, 0.006), eyeWhite)
    head.add(eye)
    eyes.push(eye)

    const brow = new THREE.Group()
    addCurve(
      brow,
      [
        new THREE.Vector3(side * 0.13, 0.095, 0.52),
        new THREE.Vector3(side * 0.25, 0.13, 0.55),
        new THREE.Vector3(side * 0.39, 0.09, 0.5),
      ],
      0.018,
      hair,
    )
    head.add(brow)
    brows.push(brow)

    addSphere(head, new THREE.Vector3(side * 0.665, -0.04, 0.015), new THREE.Vector3(0.11, 0.15, 0.08), skin)
    addSphere(head, new THREE.Vector3(side * 0.69, -0.16, 0.055), new THREE.Vector3(0.038, 0.115, 0.032), brass)
    addSphere(head, new THREE.Vector3(side * 0.69, -0.27, 0.055), new THREE.Vector3(0.055, 0.06, 0.04), brass)

    for (const [index, offset] of [-0.13, -0.04, 0.05, 0.14].entries()) {
      const strand = [
        new THREE.Vector3(side * (0.47 + offset), 0.46, 0.2),
        new THREE.Vector3(side * (0.59 + offset), 0.1, 0.4),
        new THREE.Vector3(side * (0.55 + offset), -0.2, 0.39),
        new THREE.Vector3(side * (0.68 + offset), -0.5, 0.31),
        new THREE.Vector3(side * (0.56 + offset), -0.76, 0.2),
        new THREE.Vector3(side * (0.64 + offset), -0.98, 0.1),
      ]
      addCurve(head, strand, index % 2 === 0 ? 0.045 : 0.034, hair)
      if (index % 2 === 0) {
        addCurve(
          head,
          strand.map((point) => new THREE.Vector3(point.x + side * 0.025, point.y, point.z + 0.025)),
          0.009,
          hairLight,
        )
      }
    }
  }

  addSphere(head, new THREE.Vector3(0, -0.15, 0.53), new THREE.Vector3(0.055, 0.17, 0.075), skin)
  addSphere(head, new THREE.Vector3(0, -0.28, 0.585), new THREE.Vector3(0.075, 0.06, 0.065), skin)
  addSphere(head, new THREE.Vector3(-0.045, -0.32, 0.628), new THREE.Vector3(0.018, 0.01, 0.009), shadow)
  addSphere(head, new THREE.Vector3(0.045, -0.32, 0.628), new THREE.Vector3(0.018, 0.01, 0.009), shadow)

  const mouth = addSphere(
    head,
    new THREE.Vector3(0, -0.47, 0.537),
    new THREE.Vector3(0.105, 0.008, 0.022),
    shadow,
  )
  const upperLip = new THREE.Group()
  addCurve(
    upperLip,
    [
      new THREE.Vector3(-0.145, -0.455, 0.57),
      new THREE.Vector3(-0.07, -0.437, 0.59),
      new THREE.Vector3(0, -0.454, 0.6),
      new THREE.Vector3(0.07, -0.437, 0.59),
      new THREE.Vector3(0.145, -0.455, 0.57),
    ],
    0.014,
    lip,
  )
  head.add(upperLip)
  const lowerLip = new THREE.Group()
  addCurve(
    lowerLip,
    [
      new THREE.Vector3(-0.14, -0.465, 0.57),
      new THREE.Vector3(0, -0.5, 0.592),
      new THREE.Vector3(0.14, -0.465, 0.57),
    ],
    0.016,
    lip,
  )
  head.add(lowerLip)

  const archMaterial = new THREE.MeshStandardMaterial({
    color: 0x8a725a,
    metalness: 0.72,
    roughness: 0.42,
    transparent: true,
    opacity: 0.45,
  })
  const halo = new THREE.Mesh(new THREE.TorusGeometry(1.58, 0.009, 6, 128), archMaterial)
  halo.position.set(0, 1.92, -0.9)
  root.add(halo)
  const haloCross = new THREE.Mesh(new THREE.TorusGeometry(1.72, 0.006, 5, 128), archMaterial)
  haloCross.position.set(0, 1.92, -1.08)
  haloCross.rotation.y = 0.17
  haloCross.rotation.x = 0.08
  root.add(haloCross)

  return { root, head, mouth, eyes, brows, upperLip, lowerLip }
}

function createModelSpeechFace(parent: THREE.Group) {
  const features = new THREE.Group()
  features.name = 'procedural-speaking-face'
  const darkMouth = new THREE.MeshStandardMaterial({ color: 0x241719, roughness: 0.7 })
  const lips = new THREE.MeshStandardMaterial({ color: 0x865e5c, roughness: 0.65 })
  const mouth = addSphere(
    features,
    new THREE.Vector3(0, 0.07, 0),
    new THREE.Vector3(0.002, 0.0015, 0.018),
    darkMouth,
  )
  const upperLip = addCurve(
    features,
    [
      new THREE.Vector3(-0.08, 0.073, -0.023),
      new THREE.Vector3(-0.04, 0.077, -0.012),
      new THREE.Vector3(0, 0.073, 0),
      new THREE.Vector3(0.04, 0.077, 0.012),
      new THREE.Vector3(0.08, 0.073, 0.023),
    ],
    0.002,
    lips,
  )
  const lowerLip = addCurve(
    features,
    [
      new THREE.Vector3(-0.08, 0.069, -0.023),
      new THREE.Vector3(0, 0.065, 0),
      new THREE.Vector3(0.08, 0.069, 0.023),
    ],
    0.0025,
    lips,
  )
  parent.add(features)
  return { mouth, upperLip, lowerLip }
}

export default function AvatarScene({ activity, speakingRef, speechMotionRef }: AvatarSceneProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  const activityRef = useRef(activity)

  useEffect(() => {
    activityRef.current = activity
  }, [activity])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(32, window.innerWidth / window.innerHeight, 0.1, 100)
    camera.position.set(0, 1.3, 8.8)

    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6))
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.18
    mount.appendChild(renderer.domElement)

    scene.add(new THREE.HemisphereLight(0xe5d5c5, 0x1b1718, 2.2))
    const keyLight = new THREE.DirectionalLight(0xf2d9c1, 3.2)
    keyLight.position.set(-3.5, 4.5, 6)
    scene.add(keyLight)
    const fillLight = new THREE.PointLight(0x9c6658, 17, 10)
    fillLight.position.set(3.3, 1.5, 3.2)
    scene.add(fillLight)
    const rimLight = new THREE.PointLight(0xb09a7b, 20, 11)
    rimLight.position.set(-2.8, 3.4, -2.5)
    scene.add(rimLight)

    const root = new THREE.Group()
    scene.add(root)
    let avatar: ReturnType<typeof createAvatar> | null = createAvatar()
    let modelPivot: THREE.Group | null = null
    let headPivot: THREE.Group | null = null
    let modelSpeechFace: ReturnType<typeof createModelSpeechFace> | null = null
    const pivotHeight = 2.8
    root.add(avatar.root)
    let disposed = false

    const loader = new GLTFLoader()
    loader.load(
      new URL('./3daily-model.glb', import.meta.url).href,
      (gltf) => {
        if (disposed) {
          disposeObject(gltf.scene)
          return
        }

        const human = gltf.scene
        human.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return
          child.castShadow = true
          child.receiveShadow = true
          if (!headPivot) headPivot = createHeadPivot(child)
          const materials = Array.isArray(child.material) ? child.material : [child.material]
          for (const material of materials) {
            if (!(material instanceof THREE.MeshStandardMaterial)) continue
            material.metalness = 0
            material.roughness = 0.84
            material.needsUpdate = true
          }
        })

        human.updateMatrixWorld(true)
        const bounds = new THREE.Box3().setFromObject(human)
        const size = bounds.getSize(new THREE.Vector3())
        const scale = 3.7 / size.y
        const center = bounds.getCenter(new THREE.Vector3())
        human.scale.multiplyScalar(scale)
        human.position.set(
          -center.x * scale,
          -0.9 - bounds.min.y * scale - pivotHeight,
          -center.z * scale,
        )
        human.rotation.y = -Math.PI / 2

        if (avatar) {
          root.remove(avatar.root)
          disposeObject(avatar.root)
          avatar = null
        }
        if (headPivot) modelSpeechFace = createModelSpeechFace(headPivot)
        modelPivot = new THREE.Group()
        modelPivot.position.y = pivotHeight
        modelPivot.add(human)
        root.add(modelPivot)
      },
      undefined,
      (error) => console.error('Could not load the realistic avatar model.', error),
    )

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(100, 100),
      new THREE.MeshBasicMaterial({ color: 0x100f0e, transparent: true, opacity: 0.36 }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -0.38
    scene.add(floor)

    const pointer = { x: 0, y: 0 }
    const onPointerMove = (event: PointerEvent) => {
      pointer.x = (event.clientX / window.innerWidth - 0.5) * 2
      pointer.y = (event.clientY / window.innerHeight - 0.5) * 2
    }
    const onResize = () => {
      const width = window.innerWidth
      const height = window.innerHeight
      const aspect = width / height
      camera.aspect = aspect
      camera.position.set(aspect > 1.15 ? 0.5 : 0, 1.3, aspect > 1.15 ? 8.8 : 9.2)
      camera.lookAt(aspect > 1.15 ? 0.2 : 0, 1.2, 0)
      root.position.x = aspect > 1.15 ? 0.78 : 0
      root.scale.setScalar(aspect > 1.15 ? 1 : 0.86)
      camera.updateProjectionMatrix()
      renderer.setSize(width, height)
    }

    onResize()
    window.addEventListener('resize', onResize)
    window.addEventListener('pointermove', onPointerMove, { passive: true })

    const clock = new THREE.Clock()
    let frameId = 0
    const render = () => {
      frameId = window.requestAnimationFrame(render)
      const elapsed = clock.getElapsedTime()
      const currentActivity = activityRef.current
      const speaking = speakingRef.current || currentActivity === 'speaking'
      const speechEmphasis = speechMotionRef.current
      speechMotionRef.current *= speaking ? 0.91 : 0.72
      const mouthOpen = speaking
        ? 0.0015 + Math.abs(Math.sin(elapsed * 11)) * 0.0025 + speechEmphasis * 0.006
        : 0.0015
      root.position.y = Math.sin(elapsed * 0.8) * 0.025
        + (currentActivity === 'thinking' ? Math.sin(elapsed * 3) * 0.008 : 0)

      const targetRootY = THREE.MathUtils.clamp(pointer.x * 0.22, -0.55, 0.55)
      root.rotation.y += (targetRootY - root.rotation.y) * 0.08
      if (avatar) {
        const idleDrift = Math.sin(elapsed * 0.7) * 0.018
        const targetHeadX = -pointer.y * 0.12 + idleDrift
        const targetHeadY = THREE.MathUtils.clamp(pointer.x * 0.22 + Math.sin(elapsed * 0.9) * 0.12, -0.46, 0.46)
        avatar.head.rotation.x += (targetHeadX - avatar.head.rotation.x) * 0.09
        avatar.head.rotation.y += (targetHeadY - avatar.head.rotation.y) * 0.09
        const openness = speaking ? 0.025 + Math.abs(Math.sin(elapsed * 11)) * 0.035
          + speechEmphasis * 0.055 : 0.008
        avatar.mouth.scale.y = openness
        avatar.mouth.scale.x = 0.105 + (speaking ? speechEmphasis * 0.012 : 0)
        avatar.upperLip.position.y = speaking ? openness * 0.11 : 0
        avatar.lowerLip.position.y = speaking ? -openness * 0.18 : 0
        for (const [index, brow] of avatar.brows.entries()) {
          const side = index === 0 ? -1 : 1
          const expression = speaking ? 0.035 + speechEmphasis * 0.04 : 0.01 + Math.sin(elapsed * 1.5 + side) * 0.01
          brow.rotation.z += (side * expression - brow.rotation.z) * 0.12
        }
        const blink = elapsed % 5.1 < 0.11 ? 0.12 : 1
        for (const eye of avatar.eyes) eye.scale.y = blink
      }
      if (modelPivot) {
        const listening = currentActivity === 'listening'
        const idleSway = Math.sin(elapsed * 1.1) * 0.025
        const targetPitch = speaking
          ? Math.sin(elapsed * 5.5) * 0.026
          : listening
            ? 0.025 + idleSway
            : idleSway
        const targetYaw = speaking
          ? Math.sin(elapsed * 3.8) * 0.028 + pointer.x * 0.12
          : listening
            ? -0.025 + pointer.x * 0.08
            : pointer.x * 0.1
        const targetRoll = speaking
          ? Math.sin(elapsed * 2.7) * 0.018 + pointer.y * 0.08
          : listening
            ? 0.02 + pointer.y * 0.06
            : pointer.y * 0.06
        modelPivot.rotation.x += (targetPitch - modelPivot.rotation.x) * 0.16
        modelPivot.rotation.y += (targetYaw - modelPivot.rotation.y) * 0.16
        modelPivot.rotation.z += (targetRoll - modelPivot.rotation.z) * 0.16
        const targetBob = speaking ? Math.abs(Math.sin(elapsed * 5.5)) * 0.018 : Math.abs(Math.sin(elapsed * 1.8)) * 0.012
        modelPivot.position.y += (pivotHeight + targetBob - modelPivot.position.y) * 0.16
      }
      if (modelSpeechFace) {
        modelSpeechFace.mouth.scale.y = mouthOpen
        modelSpeechFace.upperLip.position.y = speaking ? mouthOpen * 0.34 : 0
        modelSpeechFace.lowerLip.position.y = speaking ? -mouthOpen * 0.48 : 0
      }
      if (headPivot) {
        const listening = currentActivity === 'listening'
        const idleNod = Math.sin(elapsed * 1.4) * 0.014
        const nod = speaking ? Math.sin(elapsed * 7.2) * 0.045 : listening ? 0.025 + idleNod : idleNod
        const tilt = speaking ? Math.sin(elapsed * 3.2) * 0.035 : listening ? -0.045 + pointer.x * 0.08 : pointer.x * 0.08
        headPivot.rotation.x += (nod - headPivot.rotation.x) * 0.2
        headPivot.rotation.z += (tilt - headPivot.rotation.z) * 0.2
      }

      renderer.render(scene, camera)
    }
    render()

    return () => {
      disposed = true
      window.cancelAnimationFrame(frameId)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointermove', onPointerMove)
      disposeObject(scene)
      renderer.dispose()
      mount.removeChild(renderer.domElement)
    }
  }, [speakingRef, speechMotionRef])

  return <div className="avatar-scene" ref={mountRef} aria-hidden="true" />
}