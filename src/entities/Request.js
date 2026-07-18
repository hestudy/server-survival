import { SimRequest } from "../sim/request.js";

// Web-layer request: the simulation core (SimRequest) owns hop timing and
// queue admission; this subclass only adds the Three.js mesh and its motion
// along the hop. Mesh disposal is driven by the lifecycle hooks in game.js
// (immediate on finish/block, after a 500ms death flash on fail/throttle).
//
// Particle cap (issue #12): the particleBudget (wired by game.js) decides at
// spawn whether this request gets a mesh at all. Beyond the cap `this.mesh`
// stays null — the request is still fully simulated (parity pinned by
// src/render/particle-cap.parity.test.js) and its presence shows up in the
// aggregated internet-node pulse instead.
class Request extends SimRequest {
    constructor(type) {
        super(STATE.world, type);

        this.mesh = null;
        this.particleVisible = particleBudget.acquire();
        this.particleEpoch = particleBudget.epoch;
        if (!this.particleVisible) return;

        // One shared sphere geometry for every request particle; only the
        // material (color, death flash) is per-request.
        if (!Request._geometry) {
            Request._geometry = new THREE.SphereGeometry(0.4, 8, 8);
        }
        const mat = new THREE.MeshBasicMaterial({ color: this.typeConfig.color });
        this.mesh = new THREE.Mesh(Request._geometry, mat);

        this.mesh.position.copy(STATE.internetNode.position);
        this.mesh.position.y = 2;
        requestGroup.add(this.mesh);

        this.origin = STATE.internetNode.position.clone();
        this.origin.y = 2;
    }

    flyTo(service) {
        if (this.mesh) this.origin.copy(this.mesh.position);
        super.flyTo(service);
    }

    update(dt) {
        const wasMoving = this.isMoving;
        super.update(dt);

        if (!this.mesh || !this.target) return;
        if (wasMoving && !this.isMoving) {
            this.mesh.position.copy(this.target.position);
            this.mesh.position.y = 2;
        } else if (this.isMoving) {
            const dest = this.target.position.clone();
            dest.y = 2;
            this.mesh.position.lerpVectors(this.origin, dest, this.progress);
            this.mesh.position.y += Math.sin(this.progress * Math.PI) * 2;
        }
    }

    destroy() {
        particleBudget.release(this.particleVisible, this.particleEpoch);
        this.particleEpoch = -1; // a second destroy() must not release again
        if (!this.mesh) return;
        requestGroup.remove(this.mesh);
        this.mesh.material.dispose(); // geometry is shared — never disposed
        this.mesh = null;
    }
}

// Transitional global bridge (ADR-0002 expand step): instantiated by game.js.
window.Request = Request;
