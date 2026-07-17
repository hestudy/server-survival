// Transitional global bridge (ADR-0002 expand step): the legacy scripts still
// talk to Three.js through the `THREE` global the CDN build used to provide.
// This module must be imported before any of them.
import * as THREE from "three";

window.THREE = THREE;
