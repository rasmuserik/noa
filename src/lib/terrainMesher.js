'use strict'




var mesher
module.exports = function (noa) {
    if (!mesher) mesher = new TerrainMesher(noa)
    return mesher
}


// enable for profiling..
var PROFILE = 0




/*
 * 
 *          TERRAIN MESHER!!
 * 
*/


function TerrainMesher(noa) {

    var greedyMesher = new GreedyMesher()
    var meshBuilder = new MeshBuilder(noa)


    /*
     * 
     * Entry point and high-level flow
     * 
    */

    this.meshChunk = function (chunk, matGetter, colGetter, ignoreMaterials, useAO, aoVals, revAoVal) {
        profile_hook('start')

        // args
        var array = chunk.array
        var mats = matGetter || noa.registry.getBlockFaceMaterialAccessor()
        var cols = colGetter || noa.registry.getMaterialVertexColorAccessor()
        var ao = (useAO === undefined) ? noa.rendering.useAO : useAO
        var vals = aoVals || noa.rendering.aoVals
        var rev = isNaN(revAoVal) ? noa.rendering.revAoVal : revAoVal

        // greedy mesher creates an array of Submesh structs
        var subMeshes = greedyMesher.mesh(array, mats, cols, ao, vals, rev)

        // builds the babylon mesh that will be added to the scene
        var mesh
        if (subMeshes.length) {
            mesh = meshBuilder.build(subMeshes, chunk, ignoreMaterials)
            profile_hook('built terrain')
        }

        profile_hook('end')
        return mesh || null
    }

}




/*
 * 
 *  Submesh - holds one submesh worth of greedy-meshed data
 * 
 *  Basically, the greedy mesher builds these and the mesh builder consumes them
 * 
*/

function Submesh(id) {
    this.id = id | 0
    this.positions = []
    this.indices = []
    this.normals = []
    this.colors = []
    this.uvs = []
}

Submesh.prototype.dispose = function () {
    this.positions = null
    this.indices = null
    this.normals = null
    this.colors = null
    this.uvs = null
}








/*
 * 
 *  Mesh Builder - turns an array of Submesh data into a 
 *  Babylon.js mesh and child meshes, ready to be added to the scene
 * 
*/

function MeshBuilder(noa) {

    var scene = noa.rendering.getScene()
    var registry = noa.registry
    var baseMaterial = noa.rendering.flatMaterial


    this.build = function (meshdata, chunk, ignoreMaterials) {

        // preprocess meshdata entries to merge those that use default terrain material
        var mdat, i
        var first = null
        var keylist = Object.keys(meshdata)
        for (i = 0; i < keylist.length; ++i) {
            mdat = meshdata[keylist[i]]

            if (!ignoreMaterials) {
                var url = registry.getMaterialTexture(mdat.id)
                var alpha = registry.getMaterialData(mdat.id).alpha
                if (url || alpha < 1) continue
            }

            if (!first) {
                first = mdat
            } else {
                // merge data in "mdat" onto "first"
                var offset = first.positions.length / 3
                first.positions = first.positions.concat(mdat.positions)
                first.normals = first.normals.concat(mdat.normals)
                first.colors = first.colors.concat(mdat.colors)
                first.uvs = first.uvs.concat(mdat.uvs)
                // indices must be offset relative to data being merged onto
                for (var j = 0, len = mdat.indices.length; j < len; ++j) {
                    first.indices.push(mdat.indices[j] + offset)
                }
                // get rid of entry that's been merged
                mdat.dispose()
                delete meshdata[keylist[i]]
            }
        }

        // go through (remaining) meshdata entries and create a mesh for each
        var builtMeshes = []
        keylist = Object.keys(meshdata)
        for (i = 0; i < keylist.length; ++i) {
            mdat = meshdata[keylist[i]]
            var matID = mdat.id
            var name = 'terrain_' + chunk.id + ' id_' + matID
            var mesh = new BABYLON.Mesh(name, scene)
            builtMeshes.push(mesh)

            mesh.material = (ignoreMaterials) ? baseMaterial : getOrCreateMaterial(matID)

            var vdat = new BABYLON.VertexData()
            vdat.positions = mdat.positions
            vdat.indices = mdat.indices
            vdat.normals = mdat.normals
            vdat.colors = mdat.colors
            vdat.uvs = mdat.uvs
            vdat.applyToMesh(mesh)

            mdat.dispose()
        }

        // if more than one mesh is made, give them an empty parent
        var parent
        if (builtMeshes.length > 1) {
            parent = new BABYLON.Mesh('chunk_' + chunk.id, scene)
            for (var s in builtMeshes) builtMeshes[s].parent = parent
        } else {
            parent = builtMeshes[0]
            parent.name = 'chunk_' + chunk.id
        }

        // position the parent
        var x = chunk.i * chunk.size
        var y = chunk.j * chunk.size
        var z = chunk.k * chunk.size
        parent.position.x = x
        parent.position.y = y
        parent.position.z = z

        // freeze everyone and exit
        parent.freezeWorldMatrix()
        parent.freezeNormals()

        for (var s2 in builtMeshes) {
            builtMeshes[s2].freezeWorldMatrix()
            builtMeshes[s2].freezeNormals()
        }

        return parent
    }





    var materialCache = {}

    // manage materials/textures to avoid duplicating them
    function getOrCreateMaterial(matID) {
        var name = 'terrain mat ' + matID
        if (!materialCache[name]) materialCache[name] = makeTerrainMaterial(matID)
        return materialCache[name]
    }


    // canonical function to make a terrain material
    function makeTerrainMaterial(id) {
        var url = registry.getMaterialTexture(id)
        var matData = registry.getMaterialData(id)
        var alpha = matData.alpha
        if (!url && alpha == 1) {
            // base material is fine for non-textured case, if no alpha
            return baseMaterial
        }
        var mat = baseMaterial.clone('terrain' + id)
        if (url) {
            var tex = new BABYLON.Texture(url, scene, true, false, BABYLON.Texture.NEAREST_SAMPLINGMODE)
            if (matData.textureAlpha) {
                tex.hasAlpha = true
                mat.diffuseTexture = tex
            } else {
                mat.ambientTexture = tex
            }
        }
        if (matData.alpha < 1) {
            mat.alpha = matData.alpha
        }
        return mat
    }
}








/*
 *    Greedy voxel meshing algorithm
 *        based initially on algo by Mikola Lysenko:
 *          http://0fps.net/2012/07/07/meshing-minecraft-part-2/
 *          but evolved quite a bit since then
 *        AO handling by me, stitched together out of cobwebs and dreams
 *    
 *    Arguments:
 *        arr: 3D ndarray of dimensions X,Y,Z
 *             packed with solidity/opacity booleans in higher bits
 *        getMaterial: function( blockID, dir )
 *             returns a material ID based on block id and which cube face it is
 *             (assume for now that each mat ID should get its own mesh)
 *        getColor: function( materialID )
 *             looks up a color (3-array) by material ID
 *             TODO: replace this with a lookup array?
 *        doAO: whether or not to bake ambient occlusion into vertex colors
 *        aoValues: array[3] of color multipliers for AO (least to most occluded)
 *        revAoVal: "reverse ao" - color multiplier for unoccluded exposed edges
 *
 *    Return object: array of mesh objects keyed by material ID
 *        arr[id] = {
 *          id:       material id for mesh
 *          vertices: ints, range 0 .. X/Y/Z
 *          indices:  ints
 *          normals:  ints,   -1 .. 1
 *          colors:   floats,  0 .. 1
 *          uvs:      floats,  0 .. X/Y/Z
 *        }
*/

function GreedyMesher() {

    // data representation constants
    var constants = require('./constants')

    var ID_MASK = constants.ID_MASK
    var VAR_MASK = constants.VAR_MASK
    var SOLID_BIT = constants.SOLID_BIT
    var OPAQUE_BIT = constants.OPAQUE_BIT
    var OBJECT_BIT = constants.OBJECT_BIT


    var maskCache = new Int16Array(256),
        aomaskCache = new Uint16Array(256)




    this.mesh = function (arr, getMaterial, getColor, doAO, aoValues, revAoVal) {

        // return object, holder for Submeshes
        var subMeshes = []

        // precalc how to apply AO packing in first masking function
        var skipReverseAO = (doAO && (revAoVal === aoValues[0]))
        var aoPackFcn
        if (doAO) aoPackFcn = (skipReverseAO) ? packAOMaskNoReverse : packAOMask


        //Sweep over each axis, mapping axes to [d,u,v]
        for (var d = 0; d < 3; ++d) {
            var u = (d + 1) % 3
            var v = (d + 2) % 3

            // make transposed ndarray so index i is the axis we're sweeping
            var arrT = arr.transpose(d, u, v).lo(1, 1, 1).hi(arr.shape[d] - 2, arr.shape[u] - 2, arr.shape[v] - 2)

            // shorten len0 by 1 so faces at edges don't get drawn in both chunks
            var len0 = arrT.shape[0] - 1
            var len1 = arrT.shape[1]
            var len2 = arrT.shape[2]

            // preallocate mask arrays if needed
            if (maskCache.length < len1 * len2) {
                maskCache = new Int16Array(len1 * len2)
                aomaskCache = new Uint16Array(len1 * len2)
            }

            // iterate along current major axis..
            for (var i = 0; i <= len0; ++i) {

                // fills mask and aomask arrays with values
                constructMeshMasks(i, d, arrT, getMaterial, aoPackFcn)
                profile_hook('built masks')

                // parses the masks to do greedy meshing
                constructMeshDataFromMasks(i, d, u, v, len1, len2,
                    doAO, subMeshes, getColor, aoValues, revAoVal)

                profile_hook('build submeshes')
            }
        }

        // done, return array of submeshes
        return subMeshes
    }







    //      Greedy meshing inner loop one
    //
    // iterating across ith 2d plane, with n being index into masks

    function constructMeshMasks(i, d, arrT, getMaterial, aoPackFcn) {
        var len = arrT.shape[1]
        var mask = maskCache
        var aomask = aomaskCache
        // set up for quick array traversals
        var n = 0
        var data = arrT.data
        var dbase = arrT.index(i - 1, 0, 0)
        var istride = arrT.stride[0]
        var jstride = arrT.stride[1]
        var kstride = arrT.stride[2]

        for (var k = 0; k < len; ++k) {
            var d0 = dbase
            dbase += kstride
            for (var j = 0; j < len; j++ , n++ , d0 += jstride) {

                // mask[n] will represent the face needed between i-1,j,k and i,j,k
                // for now, assume we never have two faces in both directions

                // IDs at i-1,j,k  and  i,j,k
                var id0 = data[d0]
                var id1 = data[d0 + istride]

                var faceDir = getFaceDir(id0, id1)
                if (faceDir) {
                    // set regular mask value to material ID, sign indicating direction
                    mask[n] = (faceDir > 0) ?
                        getMaterial(id0 & ID_MASK, d * 2) :
                        -getMaterial(id1 & ID_MASK, d * 2 + 1)

                    // if doing AO, precalculate AO level for each face into second mask
                    if (aoPackFcn) {
                        // i values in direction face is/isn't pointing
                        var ipos = (faceDir > 0) ? i : i - 1
                        var ineg = (faceDir > 0) ? i - 1 : i

                        // this got so big I rolled it into a function
                        aomask[n] = aoPackFcn(arrT, ipos, ineg, j, k)
                    }
                }

            }
        }
    }

    function constructMeshMasksB(i, d, arrT, getMaterial, aoPackFcn) {
        var len = arrT.shape[1]
        var mask = maskCache
        var aomask = aomaskCache

        // traversal
        var n = 0
        var data = arrT.data
        var dbase = arrT.index(i - 1, 0, 0)
        var istride = arrT.stride[0]
        var jstride = arrT.stride[1]
        var kstride = arrT.stride[2]

        for (var k = 0; k < len; ++k) {
            var d0 = dbase
            dbase += kstride
            for (var j = 0; j < len; ++j) {

                // mask[n] will represent the face needed between i-1,j,k and i,j,k
                // for now, assume we never have two faces in both directions
                // So mask value is face material id, sign is direction

                // IDs at i-1,j,k  and  i,j,k
                var id0 = data[d0]
                var id1 = data[d0 + istride]

                var faceDir = getFaceDir(id0, id1)
                if (faceDir) {
                    // set regular mask value to material ID, sign indicating direction
                    mask[n] = (faceDir > 0) ?
                        getMaterial(id0 & ID_MASK, d * 2) :
                        -getMaterial(id1 & ID_MASK, d * 2 + 1)

                    // if doing AO, precalculate AO level for each face into second mask
                    if (aoPackFcn) {
                        // i values in direction face is/isn't pointing
                        var ipos = (faceDir > 0) ? i : i - 1
                        var ineg = (faceDir > 0) ? i - 1 : i

                        // this got so big I rolled it into a function
                        aomask[n] = aoPackFcn(arrT, ipos, ineg, j, k)
                    }
                }

                // done, move to next mask index
                d0 += jstride
                n++
            }
        }
    }


    function getFaceDir(id0, id1) {
        // no face if both blocks are opaque, or if ids match
        if (id0 === id1) return 0
        var op0 = id0 & OPAQUE_BIT
        var op1 = id1 & OPAQUE_BIT
        if (op0 && op1) return 0
        // if either block is opaque draw a face for it
        if (op0) return 1
        if (op1) return -1
        // if one block is air or an object block draw face for the other
        if (id1 === 0 || (id1 & OBJECT_BIT)) return 1
        if (id0 === 0 || (id0 & OBJECT_BIT)) return -1
        // only remaining case is two different non-opaque non-air blocks that are adjacent
        // really we should draw both faces here; draw neither for now
        return 0
    }







    //      Greedy meshing inner loop two
    //
    // construct data for mesh using the masks

    function constructMeshDataFromMasks(i, d, u, v, len1, len2,
        doAO, submeshes, getColor, aoValues, revAoVal) {
        var n = 0
        var mask = maskCache
        var aomask = aomaskCache

        // some logic is broken into helper functions for AO and non-AO
        // this fixes deopts in Chrome (for reasons unknown)
        var maskCompareFcn = (doAO) ? maskCompare : maskCompare_noAO
        var meshColorFcn = (doAO) ? pushMeshColors : pushMeshColors_noAO

        for (var k = 0; k < len2; ++k) {
            var w = 1
            var h = 1
            for (var j = 0; j < len1; j += w, n += w) {

                var maskVal = mask[n]
                if (!maskVal) {
                    w = 1
                    continue
                }
                var ao = aomask[n]

                // Compute width and height of area with same mask/aomask values
                for (w = 1; w < len1 - j; ++w) {
                    if (!maskCompareFcn(n + w, mask, maskVal, aomask, ao)) break
                }

                OUTER:
                for (h = 1; h < len2 - k; ++h) {
                    for (var m = 0; m < w; ++m) {
                        var ix = n + m + h * len1
                        if (!maskCompareFcn(ix, mask, maskVal, aomask, ao)) break OUTER
                    }
                }

                // for testing: doing the following will disable greediness
                //w=h=1

                // material and mesh for this face
                var matID = Math.abs(maskVal)
                if (!submeshes[matID]) submeshes[matID] = new Submesh(matID)
                var mesh = submeshes[matID]
                var colors = mesh.colors
                var c = getColor(matID)

                // colors are pushed in helper function - avoids deopts
                // tridir is boolean for which way to split the quad into triangles

                var triDir = meshColorFcn(colors, c, ao, aoValues, revAoVal)


                //Add quad, vertices = x -> x+du -> x+du+dv -> x+dv
                var x = [0, 0, 0]
                x[d] = i
                x[u] = j
                x[v] = k
                var du = [0, 0, 0]; du[u] = w;
                var dv = [0, 0, 0]; dv[v] = h;

                var pos = mesh.positions
                pos.push(
                    x[0], x[1], x[2],
                    x[0] + du[0], x[1] + du[1], x[2] + du[2],
                    x[0] + du[0] + dv[0], x[1] + du[1] + dv[1], x[2] + du[2] + dv[2],
                    x[0] + dv[0], x[1] + dv[1], x[2] + dv[2])


                // add uv values, with the order and sign depending on 
                // axis and direction so as to avoid mirror-image textures
                var dir = (maskVal > 0) ? 1 : -1

                if (d === 2) {
                    mesh.uvs.push(
                        0, h,
                        -dir * w, h,
                        -dir * w, 0,
                        0, 0)
                } else {
                    mesh.uvs.push(
                        0, w,
                        0, 0,
                        dir * h, 0,
                        dir * h, w)
                }


                // Add indexes, ordered clockwise for the facing direction;

                var vs = pos.length / 3 - 4

                if (maskVal < 0) {
                    if (triDir) {
                        mesh.indices.push(vs, vs + 1, vs + 2, vs, vs + 2, vs + 3)
                    } else {
                        mesh.indices.push(vs + 1, vs + 2, vs + 3, vs, vs + 1, vs + 3)
                    }
                } else {
                    if (triDir) {
                        mesh.indices.push(vs, vs + 2, vs + 1, vs, vs + 3, vs + 2)
                    } else {
                        mesh.indices.push(vs + 3, vs + 1, vs, vs + 3, vs + 2, vs + 1)
                    }
                }


                // norms depend on which direction the mask was solid in..
                var norm0 = d === 0 ? dir : 0
                var norm1 = d === 1 ? dir : 0
                var norm2 = d === 2 ? dir : 0

                // same norm for all vertices
                mesh.normals.push(
                    norm0, norm1, norm2,
                    norm0, norm1, norm2,
                    norm0, norm1, norm2,
                    norm0, norm1, norm2)


                //Zero-out mask
                for (var hx = 0; hx < h; ++hx) {
                    for (var wx = 0; wx < w; ++wx) {
                        mask[n + wx + hx * len1] = 0
                    }
                }

            }
        }
    }



    // Two helper functions with AO and non-AO implementations:

    function maskCompare(index, mask, maskVal, aomask, aoVal) {
        if (maskVal !== mask[index]) return false
        if (aoVal !== aomask[index]) return false
        return true
    }

    function maskCompare_noAO(index, mask, maskVal, aomask, aoVal) {
        if (maskVal !== mask[index]) return false
        return true
    }

    function pushMeshColors_noAO(colors, c, ao, aoValues, revAoVal) {
        colors.push(c[0], c[1], c[2], 1)
        colors.push(c[0], c[1], c[2], 1)
        colors.push(c[0], c[1], c[2], 1)
        colors.push(c[0], c[1], c[2], 1)
        return true // triangle direction doesn't matter for non-AO
    }

    function pushMeshColors(colors, c, ao, aoValues, revAoVal) {
        var ao00 = unpackAOMask(ao, 0, 0)
        var ao10 = unpackAOMask(ao, 1, 0)
        var ao11 = unpackAOMask(ao, 1, 1)
        var ao01 = unpackAOMask(ao, 0, 1)
        pushAOColor(colors, c, ao00, aoValues, revAoVal)
        pushAOColor(colors, c, ao10, aoValues, revAoVal)
        pushAOColor(colors, c, ao11, aoValues, revAoVal)
        pushAOColor(colors, c, ao01, aoValues, revAoVal)

        // this bit is pretty magical..
        var triDir = true
        if (ao00 === ao11) {
            triDir = (ao01 === ao10) ? (ao01 == 2) : true
        } else {
            triDir = (ao01 === ao10) ? false : (ao00 + ao11 > ao01 + ao10)
        }
        return triDir
    }





    /* 
     *  packAOMask:
     *
     *    For a given face, find occlusion levels for each vertex, then
     *    pack 4 such (2-bit) values into one Uint8 value
     * 
     *  Occlusion levels:
     *    1 is flat ground, 2 is partial occlusion, 3 is max (corners)
     *    0 is "reverse occlusion" - an unoccluded exposed edge 
     *  Packing order var(bit offset):
     *      a01(2)  -   a11(6)   ^  K
     *        -     -            +> J
     *      a00(0)  -   a10(4)
    */

    // when skipping reverse AO, uses this simpler version of the function:

    function packAOMaskNoReverse(data, ipos, ineg, j, k) {
        var a00 = 1
        var a01 = 1
        var a10 = 1
        var a11 = 1
        var solidBit = SOLID_BIT

        // facing into a solid (non-opaque) block?
        var facingSolid = (solidBit & data.get(ipos, j, k))

        // inc occlusion of vertex next to obstructed side
        if (data.get(ipos, j + 1, k) & solidBit) { ++a10; ++a11 }
        if (data.get(ipos, j - 1, k) & solidBit) { ++a00; ++a01 }
        if (data.get(ipos, j, k + 1) & solidBit) { ++a01; ++a11 }
        if (data.get(ipos, j, k - 1) & solidBit) { ++a00; ++a10 }

        // treat corners differently based when facing a solid block
        if (facingSolid) {
            // always 2, or 3 in corners
            a11 = (a11 == 3 || data.get(ipos, j + 1, k + 1) & solidBit) ? 3 : 2
            a01 = (a01 == 3 || data.get(ipos, j - 1, k + 1) & solidBit) ? 3 : 2
            a10 = (a10 == 3 || data.get(ipos, j + 1, k - 1) & solidBit) ? 3 : 2
            a00 = (a00 == 3 || data.get(ipos, j - 1, k - 1) & solidBit) ? 3 : 2
        } else {
            // treat corner as occlusion 3 only if not occluded already
            if (a11 === 1 && (data.get(ipos, j + 1, k + 1) & solidBit)) { a11 = 2 }
            if (a01 === 1 && (data.get(ipos, j - 1, k + 1) & solidBit)) { a01 = 2 }
            if (a10 === 1 && (data.get(ipos, j + 1, k - 1) & solidBit)) { a10 = 2 }
            if (a00 === 1 && (data.get(ipos, j - 1, k - 1) & solidBit)) { a00 = 2 }
        }

        return a11 << 6 | a10 << 4 | a01 << 2 | a00
    }

    // more complicated AO packing when doing reverse AO on corners

    function packAOMask(data, ipos, ineg, j, k) {
        var a00 = 1
        var a01 = 1
        var a10 = 1
        var a11 = 1
        var solidBit = SOLID_BIT

        // facing into a solid (non-opaque) block?
        var facingSolid = (solidBit & data.get(ipos, j, k))

        // inc occlusion of vertex next to obstructed side
        if (data.get(ipos, j + 1, k) & solidBit) { ++a10; ++a11 }
        if (data.get(ipos, j - 1, k) & solidBit) { ++a00; ++a01 }
        if (data.get(ipos, j, k + 1) & solidBit) { ++a01; ++a11 }
        if (data.get(ipos, j, k - 1) & solidBit) { ++a00; ++a10 }

        if (facingSolid) {
            // always 2, or 3 in corners
            a11 = (a11 == 3 || data.get(ipos, j + 1, k + 1) & solidBit) ? 3 : 2
            a01 = (a01 == 3 || data.get(ipos, j - 1, k + 1) & solidBit) ? 3 : 2
            a10 = (a10 == 3 || data.get(ipos, j + 1, k - 1) & solidBit) ? 3 : 2
            a00 = (a00 == 3 || data.get(ipos, j - 1, k - 1) & solidBit) ? 3 : 2
        } else {

            // check each corner, and if not present do reverse AO
            if (a11 === 1) {
                if (data.get(ipos, j + 1, k + 1) & solidBit) { a11 = 2 }
                else if (!(data.get(ineg, j, k + 1) & solidBit) ||
                    !(data.get(ineg, j + 1, k) & solidBit) ||
                    !(data.get(ineg, j + 1, k + 1) & solidBit)) {
                    a11 = 0
                }
            }

            if (a10 === 1) {
                if (data.get(ipos, j + 1, k - 1) & solidBit) { a10 = 2 }
                else if (!(data.get(ineg, j, k - 1) & solidBit) ||
                    !(data.get(ineg, j + 1, k) & solidBit) ||
                    !(data.get(ineg, j + 1, k - 1) & solidBit)) {
                    a10 = 0
                }
            }

            if (a01 === 1) {
                if (data.get(ipos, j - 1, k + 1) & solidBit) { a01 = 2 }
                else if (!(data.get(ineg, j, k + 1) & solidBit) ||
                    !(data.get(ineg, j - 1, k) & solidBit) ||
                    !(data.get(ineg, j - 1, k + 1) & solidBit)) {
                    a01 = 0
                }
            }

            if (a00 === 1) {
                if (data.get(ipos, j - 1, k - 1) & solidBit) { a00 = 2 }
                else if (!(data.get(ineg, j, k - 1) & solidBit) ||
                    !(data.get(ineg, j - 1, k) & solidBit) ||
                    !(data.get(ineg, j - 1, k - 1) & solidBit)) {
                    a00 = 0
                }
            }
        }

        return a11 << 6 | a10 << 4 | a01 << 2 | a00
    }



    // unpack (2 bit) ao value from ao mask
    // see above for details
    function unpackAOMask(aomask, jpos, kpos) {
        var offset = jpos ? (kpos ? 6 : 4) : (kpos ? 2 : 0)
        return aomask >> offset & 3
    }


    // premultiply vertex colors by value depending on AO level
    // then push them into color array
    function pushAOColor(colors, baseCol, ao, aoVals, revAoVal) {
        var mult = (ao === 0) ? revAoVal : aoVals[ao - 1]
        colors.push(baseCol[0] * mult, baseCol[1] * mult, baseCol[2] * mult, 1)
    }

}















var profile_hook = (function () {
    if (!PROFILE) return function () { }
    var every = 200
    var timer = new (require('./util').Timer)(every, 'Terrain meshing')
    return function (state) {
        if (state === 'start') timer.start()
        else if (state === 'end') timer.report()
        else timer.add(state)
    }
})()
