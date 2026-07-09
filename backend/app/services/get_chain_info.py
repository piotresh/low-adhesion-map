import json
import math
import os

# Global cache to store the GeoJSON data in memory
_GEOJSON_CACHE = None

def load_geojson_data(file_path):
    """
    Reads the GeoJSON file from disk and caches it globally.
    Call this once at startup or during initialization.
    """
    global _GEOJSON_CACHE
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"GeoJSON file not found: {file_path}")
    
    with open(file_path, 'r') as f:
        _GEOJSON_CACHE = json.load(f)
    
    print(f"✅ Loaded {_GEOJSON_CACHE.get('type', 'data')} from {file_path}")
    return _GEOJSON_CACHE

def _haversine_distance(lat1, lon1, lat2, lon2):
    """
    Calculates the distance in meters between two lat/lon points.
    """
    R = 6371000  # Radius of Earth in meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = (math.sin(delta_phi / 2) ** 2 +
         math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2)
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    return R * c

def _get_feature_centroid(geometry):
    """
    Returns a (lat, lon) tuple representing the center of the geometry.
    Handles Point and LineString types commonly found in rail data.
    """
    coords = geometry['coordinates']
    geom_type = geometry['type']

    if geom_type == 'Point':
        # GeoJSON is usually [lon, lat], so we reverse to [lat, lon]
        return (coords[1], coords[0])
    
    elif geom_type == 'LineString':
        # Calculate simple average of all vertices
        lats = [c[1] for c in coords]
        lons = [c[0] for c in coords]
        return (sum(lats) / len(lats), sum(lons) / len(lons))
    
    elif geom_type == 'MultiLineString':
        # Flatten all coordinates
        all_coords = [c for line in coords for c in line]
        lats = [c[1] for c in all_coords]
        lons = [c[0] for c in all_coords]
        return (sum(lats) / len(lats), sum(lons) / len(lons))
        
    # Fallback for Polygons or others (using first coordinate)
    elif geom_type == 'Polygon':
        # Exterior ring
        ring = coords[0]
        lats = [c[1] for c in ring]
        lons = [c[0] for c in ring]
        return (sum(lats) / len(lats), sum(lons) / len(lons))

    return None

def get_closest_chain_info(lat, lon, geojson_path=None):
    """
    Finds the closest railway chain (ELR/Mileage) to the given lat/lon.
    
    Args:
        lat (float): Latitude of the wheel slide.
        lon (float): Longitude of the wheel slide.
        geojson_path (str, optional): Path to the .geojson file. If None, 
                                     tries to use cached data.
    
    Returns:
        dict: All properties found in the GeoJSON for the closest chain 
              (e.g., ELR, Mileage, Track ID, etc.), or None if no data found.
    """
    global _GEOJSON_CACHE

    # Load data if not cached
    if not _GEOJSON_CACHE:
        if not geojson_path:
            raise ValueError("GeoJSON not loaded and no path provided.")
        load_geojson_data(geojson_path)

    closest_feature = None
    min_distance = float('inf')

    # Iterate through all features to find the nearest one
    for feature in _GEOJSON_CACHE.get('features', []):
        centroid = _get_feature_centroid(feature.get('geometry'))
        if not centroid:
            continue

        # Calculate distance from slide to this feature's centroid
        distance = _haversine_distance(lat, lon, centroid[0], centroid[1])

        if distance < min_distance:
            min_distance = distance
            closest_feature = feature

    # Return the properties of the closest feature
    if closest_feature:
        # Add the calculated distance to the output for verification
        result = closest_feature.get('properties', {})
        result['_distance_meters'] = round(min_distance, 2)
        return result

    return None