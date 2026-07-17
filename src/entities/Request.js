import { SimRequest } from "../sim/request.js";

// Web-layer request: the simulation core (SimRequest) owns hop timing and
// queue admission; this subclass only adds the Three.js mesh and its motion
// along the hop. Mesh disposal is driven by the lifecycle hooks in game.js
// (immediate on finish/block, after a 500ms death flash on fail/throttle).
class Request extends SimRequest {
    constructor(type) {
        super(STATE.world, type);

        const color = this.typeConfig.color;

        const geo = new THREE.SphereGeometry(0.4, 8, 8);
        const mat = new THREE.MeshBasicMaterial({ color: color });
        this.mesh = new THREE.Mesh(geo, mat);

        this.mesh.position.copy(STATE.internetNode.position);
        this.mesh.position.y = 2;
        requestGroup.add(this.mesh);

        this.origin = STATE.internetNode.position.clone();
        this.origin.y = 2;
    }

    flyTo(service) {
        this.origin.copy(this.mesh.position);
        super.flyTo(service);
    }

    update(dt) {
        const wasMoving = this.isMoving;
        super.update(dt);

        if (!this.target) return;
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
        requestGroup.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
    }
}

// Transitional global bridge (ADR-0002 expand step): instantiated by game.js.
window.Request = Request;
