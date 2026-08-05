import React, { useRef, useEffect, useCallback, useMemo, useState } from 'react'
import ForceGraph3D from 'react-force-graph-3d'
import * as THREE from 'three'

// Lazy-load post-processing to avoid hard failures
let UnrealBloomPass, EffectComposer, RenderPass
async function loadPostProcessing() {
  if (UnrealBloomPass) return
  const pp = await import('three/examples/jsm/postprocessing/UnrealBloomPass.js')
  const ec = await import('three/examples/jsm/postprocessing/EffectComposer.js')
  const rp = await import('three/examples/jsm/postprocessing/RenderPass.js')
  UnrealBloomPass = pp.UnrealBloomPass
  EffectComposer = ec.EffectComposer
  RenderPass = rp.RenderPass
}

function createGlowSprite(color, size) {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const ctx = canvas.getContext('2d')
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  g.addColorStop(0, color)
  g.addColorStop(0.12, color + 'DD')
  g.addColorStop(0.35, color + '66')
  g.addColorStop(1, 'transparent')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 128, 128)
  const tex = new THREE.CanvasTexture(canvas)
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: 1,
  })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(size * 4, size * 4, 1)
  return sprite
}

function createStardust(count = 5000) {
  const geom = new THREE.BufferGeometry()
  const pos = new Float32Array(count * 3)
  for (let i = 0; i < count * 3; i++) {
    pos[i] = (Math.random() - 0.5) * 900
  }
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  const mat = new THREE.PointsMaterial({
    size: 0.5,
    color: 0xffffff,
    transparent: true,
    opacity: 0.3,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const pts = new THREE.Points(geom, mat)
  pts.name = 'stardust'
  return pts
}

export default function Graph({ data, onNodeClick, highlightComm, selectedNode }) {
  const fgRef = useRef(null)
  const containerRef = useRef(null)
  const [dims, setDims] = useState({ w: window.innerWidth, h: window.innerHeight })
  const [ready, setReady] = useState(false)
  const spriteCache = useRef(new Map())

  // ResizeObserver for proper dimensions
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const cr = entry.contentRect
        setDims({ w: cr.width, h: cr.height })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Build neighbor map once
  const neighborMap = useMemo(() => {
    const map = new Map()
    data.nodes.forEach(n => map.set(n.id, new Set()))
    data.links.forEach(l => {
      const s = typeof l.source === 'object' ? l.source.id : l.source
      const t = typeof l.target === 'object' ? l.target.id : l.target
      map.get(s)?.add(t)
      map.get(t)?.add(s)
    })
    return map
  }, [data])

  const nodesById = useMemo(() => {
    const m = new Map()
    data.nodes.forEach(n => m.set(n.id, n))
    return m
  }, [data])

  // Post-processing, stardust, camera entrance, wheel lock
  useEffect(() => {
    const fg = fgRef.current
    if (!fg) return

    // Wait one frame for the graph to initialize its renderer
    const timer = setTimeout(async () => {
      try {
        const renderer = fg.renderer()
        const scene = fg.scene()
        const camera = fg.camera()
        if (!renderer || !scene || !camera) {
          console.warn('Graph refs not ready')
          return
        }

        // Stardust
        const dust = createStardust()
        scene.add(dust)

        // Bloom post-processing
        await loadPostProcessing()
        if (!UnrealBloomPass || !EffectComposer || !RenderPass) {
          console.warn('Post-processing modules failed to load')
        } else {
          const composer = new EffectComposer(renderer)
          composer.addPass(new RenderPass(scene, camera))
          const bloom = new UnrealBloomPass(
            new THREE.Vector2(dims.w, dims.h),
            1.4, 0.3, 0.85
          )
          composer.addPass(bloom)

          // Override renderer.render to use composer, with a re-entrancy guard:
          // the graph's animation loop calls renderer.render() once per frame -> run the composer.
          // The composer's passes (e.g. RenderPass) also call renderer.render() internally;
          // those must forward to the real renderer, otherwise we recurse infinitely.
          const origRender = renderer.render.bind(renderer)
          let composerRendering = false
          renderer.render = function (...args) {
            if (composerRendering) {
              return origRender.apply(this, args)
            }
            composerRendering = true
            try {
              composer.render()
            } finally {
              composerRendering = false
            }
          }

          // Resize handler for composer
          const onResize = () => {
            const w = containerRef.current?.clientWidth || window.innerWidth
            const h = containerRef.current?.clientHeight || window.innerHeight
            renderer.setSize(w, h)
            composer.setSize(w, h)
            camera.aspect = w / h
            camera.updateProjectionMatrix()
          }
          window.addEventListener('resize', onResize)

          // Cleanup function
          window._graphCleanup = () => {
            renderer.render = origRender
            window.removeEventListener('resize', onResize)
            scene.remove(dust)
          }
        }

        // Camera entrance animation
        camera.position.set(0, 0, 750)
        const targetZ = 300
        let raf
        const zoomIn = () => {
          if (camera.position.z > targetZ) {
            camera.position.z -= 5
            raf = requestAnimationFrame(zoomIn)
          }
        }
        setTimeout(zoomIn, 200)

        // Auto-rotate
        const controls = fg.controls()
        if (controls) {
          controls.autoRotate = true
          controls.autoRotateSpeed = 0.5
        }

        // Wheel: prevent page scroll, only zoom canvas
        const canvas = renderer.domElement
        const onWheel = (e) => { e.preventDefault() }
        canvas.addEventListener('wheel', onWheel, { passive: false })

        window._graphCleanup2 = () => {
          cancelAnimationFrame(raf)
          canvas.removeEventListener('wheel', onWheel)
        }

        setReady(true)
      } catch (err) {
        console.error('Graph init error:', err)
      }
    }, 100)

    return () => {
      clearTimeout(timer)
      if (window._graphCleanup) window._graphCleanup()
      if (window._graphCleanup2) window._graphCleanup2()
    }
  }, [fgRef.current, dims.w, dims.h])

  // Update sprite opacities when highlight/selection changes
  useEffect(() => {
    const fg = fgRef.current
    if (!fg) return
    const scene = fg.scene()
    if (!scene) return
    scene.traverse(obj => {
      if (obj.userData?.isNode && obj.material) {
        const node = obj.userData.node
        let opacity = 1
        if (selectedNode) {
          if (node.id === selectedNode) opacity = 1
          else if (neighborMap.get(selectedNode)?.has(node.id)) opacity = 0.6
          else opacity = 0.08
        } else if (highlightComm !== null) {
          opacity = node.community === highlightComm ? 1 : 0.1
        }
        obj.material.opacity = opacity
        const base = (node.size || 5) * 4
        const s = node.id === selectedNode ? base * 1.6 : base
        obj.scale.set(s, s, 1)
      }
    })
  }, [highlightComm, selectedNode, neighborMap])

  const handleNodeClick = useCallback((node) => {
    onNodeClick(node)
  }, [onNodeClick])

  const linkOpacity = useCallback((link) => {
    const sId = typeof link.source === 'object' ? link.source.id : link.source
    const tId = typeof link.target === 'object' ? link.target.id : link.target
    if (selectedNode) {
      if (sId === selectedNode || tId === selectedNode) return 0.25
      return 0.01
    }
    if (highlightComm !== null) {
      const sNode = nodesById.get(sId)
      const tNode = nodesById.get(tId)
      if (sNode?.community === highlightComm && tNode?.community === highlightComm) return 0.1
      return 0.01
    }
    return 0.04
  }, [selectedNode, highlightComm, nodesById])

  const nodeThreeObject = useCallback((node) => {
    const key = `${node.id}-${node.color}-${node.size}`
    if (spriteCache.current.has(key)) {
      return spriteCache.current.get(key)
    }
    const sprite = createGlowSprite(node.color, node.size || 5)
    sprite.userData = { isNode: true, node }
    spriteCache.current.set(key, sprite)
    return sprite
  }, [])

  return (
    <div ref={containerRef} className="graph-wrap">
      {dims.w > 0 && dims.h > 0 && (
        <ForceGraph3D
          ref={fgRef}
          graphData={data}
          width={dims.w}
          height={dims.h}
          backgroundColor="#020205"
          showNavInfo={false}
          nodeLabel={() => null}
          nodeRelSize={0.1}
          nodeThreeObject={nodeThreeObject}
          nodeThreeObjectExtend={false}
          linkColor={() => '#C8A951'}
          linkOpacity={linkOpacity}
          linkWidth={0.15}
          linkDirectionalParticles={0}
          onNodeClick={handleNodeClick}
          warmupTicks={0}
          cooldownTicks={0}
          d3AlphaMin={1}
          d3VelocityDecay={0}
        />
      )}
    </div>
  )
}
